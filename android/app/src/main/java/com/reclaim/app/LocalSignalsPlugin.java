package com.reclaim.app;

import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Read-only bridge from LocalSignalsDb (native SQLite, written directly by the background
 * collectors) to the WebView, for InsightsView. Never writes from JS -- everything here is
 * collected natively; the WebView only ever reads it back to display it. The one exception is the
 * allowlist, which the user manages through the UI, so JS is the source of truth there.
 */
@CapacitorPlugin(name = "LocalSignals")
public class LocalSignalsPlugin extends Plugin {

    private LocalSignalsDb db() {
        return LocalSignalsDb.getInstance(getContext());
    }

    @PluginMethod
    public void getUsageSamples(PluginCall call) {
        JSObject result = new JSObject();
        result.put("samples", db().recentUsageSamples(call.getInt("limit", 20)));
        call.resolve(result);
    }

    @PluginMethod
    public void getAppEvents(PluginCall call) {
        JSObject result = new JSObject();
        result.put("events", db().recentAppEvents(call.getInt("limit", 20)));
        call.resolve(result);
    }

    @PluginMethod
    public void getKeywordMatches(PluginCall call) {
        JSObject result = new JSObject();
        result.put("matches", db().recentKeywordMatches(call.getInt("limit", 20)));
        call.resolve(result);
    }

    @PluginMethod
    public void getAllowlist(PluginCall call) {
        // Seeding is normally triggered by turning on background sampling (BackgroundSamplerPlugin),
        // but onboarding shows this list before that toggle exists -- seed here too so it's never
        // empty-by-default just because of call order. seedDefaultAllowlistIfNeeded is itself
        // idempotent (gated on app_meta), so calling it from two places is harmless.
        db().seedDefaultAllowlistIfNeeded(getContext());
        JSObject result = new JSObject();
        result.put("apps", db().allAllowlistApps());
        call.resolve(result);
    }

    @PluginMethod
    public void addAllowlistApp(PluginCall call) {
        String packageName = call.getString("packageName");
        if (packageName == null) {
            call.reject("packageName is required");
            return;
        }
        db().upsertAllowlistApp(packageName, resolveLabel(packageName), false);
        call.resolve();
    }

    @PluginMethod
    public void removeAllowlistApp(PluginCall call) {
        String packageName = call.getString("packageName");
        if (packageName == null) {
            call.reject("packageName is required");
            return;
        }
        db().removeAllowlistApp(packageName);
        call.resolve();
    }

    // Lists apps with a launcher entry (i.e. things a person would recognize), for the "add to
    // allowlist" picker -- excludes background-only components nobody would think to add.
    @PluginMethod
    public void getInstalledApps(PluginCall call) {
        PackageManager pm = getContext().getPackageManager();
        com.getcapacitor.JSArray apps = new com.getcapacitor.JSArray();
        for (ApplicationInfo info : pm.getInstalledApplications(PackageManager.GET_META_DATA)) {
            if (pm.getLaunchIntentForPackage(info.packageName) == null) continue;
            JSObject app = new JSObject();
            app.put("packageName", info.packageName);
            app.put("label", pm.getApplicationLabel(info).toString());
            apps.put(app);
        }
        JSObject result = new JSObject();
        result.put("apps", apps);
        call.resolve(result);
    }

    // The other write path besides the allowlist: db.js/UserPreferencesStore and CheckInStore are
    // the real source of truth (user-entered/derived in the WebView), this just mirrors what
    // RiskNudgeMonitor's scoring needs into app_meta so it can read it from a background Worker
    // where the WebView isn't loaded. See RiskProfile.syncToNative (riskProfile.js) for the caller.
    @PluginMethod
    public void syncRiskContext(PluginCall call) {
        db().setMeta("accountability_name", call.getString("accountabilityName", ""));
        db().setMeta("accountability_phone", call.getString("accountabilityPhone", ""));
        db().setMeta("tempting_times", jsonArrayOrEmpty(call, "temptingTimes"));
        db().setMeta("common_triggers", jsonArrayOrEmpty(call, "commonTriggers"));
        db().setMeta("notification_intensity", call.getString("intensity", "medium"));
        db().setMeta("top_slip_tags", jsonArrayOrEmpty(call, "topSlipTags"));
        db().setMeta("risky_time_buckets", jsonArrayOrEmpty(call, "riskyTimeBuckets"));
        call.resolve();
    }

    private String jsonArrayOrEmpty(PluginCall call, String key) {
        com.getcapacitor.JSArray arr = call.getArray(key);
        return arr != null ? arr.toString() : "[]";
    }

    // RiskNudgeMonitor writes here when it posts a notification (see its own doc comment for why
    // the detail lives here instead of in the notification itself). Consumed once -- cleared on
    // read so re-opening the app later doesn't keep re-showing an old alert.
    @PluginMethod
    public void getPendingRiskAlert(PluginCall call) {
        String json = db().getMeta("pending_risk_alert");
        if (json != null) db().setMeta("pending_risk_alert", "");
        JSObject result = new JSObject();
        if (json != null && !json.isEmpty()) {
            try {
                result.put("alert", new JSObject(json));
            } catch (org.json.JSONException e) {
                // Malformed -- treat as no alert rather than failing the call.
            }
        }
        call.resolve(result);
    }

    private String resolveLabel(String packageName) {
        try {
            PackageManager pm = getContext().getPackageManager();
            return pm.getApplicationLabel(pm.getApplicationInfo(packageName, 0)).toString();
        } catch (PackageManager.NameNotFoundException e) {
            return packageName;
        }
    }
}
