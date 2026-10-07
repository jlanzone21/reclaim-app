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
        db().setMeta("accountability_name_2", call.getString("accountabilityName2", ""));
        db().setMeta("accountability_phone_2", call.getString("accountabilityPhone2", ""));
        db().setMeta("tempting_times", jsonArrayOrEmpty(call, "temptingTimes"));
        db().setMeta("common_triggers", jsonArrayOrEmpty(call, "commonTriggers"));
        db().setMeta("notification_intensity", call.getString("intensity", "medium"));
        db().setMeta("top_slip_tags", jsonArrayOrEmpty(call, "topSlipTags"));
        db().setMeta("risky_time_buckets", jsonArrayOrEmpty(call, "riskyTimeBuckets"));
        // The phrase and note templates the on-device AI wrote -- see RiskNotificationText.
        com.getcapacitor.JSObject bank = call.getObject("phraseBank");
        db().setMeta("phrase_bank", bank != null ? bank.toString() : "{}");
        com.getcapacitor.JSObject notes = call.getObject("noteBank");
        db().setMeta("note_bank", notes != null ? notes.toString() : "{}");
        // Which daily passage a nudge offers to pray through -- see RiskPassage / PassageBank.getPlan.
        com.getcapacitor.JSObject plan = call.getObject("passagePlan");
        db().setMeta("passage_plan", plan != null ? plan.toString() : "");
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

    // NightlyCheckinActionReceiver writes here when a notification action is actually tapped (see
    // NightlyCheckinWorker's own comment for why it's not set at post time). "quick_resisted" or
    // "open_checkin" -- consumed once, cleared on read, same reasoning as getPendingRiskAlert.
    @PluginMethod
    public void getPendingNightlyAction(PluginCall call) {
        String action = db().getMeta("pending_nightly_action");
        if (action != null) db().setMeta("pending_nightly_action", "");
        JSObject result = new JSObject();
        result.put("action", action != null && !action.isEmpty() ? action : null);
        call.resolve(result);
    }

    // MainActivity.handleRiskIntent writes here when the notification's "Read a verse" action
    // specifically (not a body tap) is what opened the app -- "1" or null, consumed once, cleared
    // on read, same reasoning as getPendingNightlyAction. app.js checks this before
    // getPendingRiskAlert on boot/resume so the auto-submitted scripture request wins over the
    // detail popup (MainActivity already cleared pending_risk_alert itself for this same reason).
    @PluginMethod
    public void getPendingVerseRequest(PluginCall call) {
        String flag = db().getMeta("pending_verse_request");
        if (flag != null) db().setMeta("pending_verse_request", "");
        JSObject result = new JSObject();
        result.put("pending", "1".equals(flag) || "resources".equals(flag));
        result.put("kind", "resources".equals(flag) ? "resources" : "verse");
        call.resolve(result);
    }

    // How long after a risk-nudge notification a check-in can still plausibly be a reaction to
    // it, for RiskScorer's adaptive-tuning loop below. Long enough to cover "later that day"
    // (including the nightly check-in prompt), short enough that an unrelated check-in from days
    // later never gets attributed to a stale notification.
    private static final long CORRELATION_WINDOW_MS = 6L * 60 * 60 * 1000;

    // Called by CheckInStore.add() (checkinStore.js) right after logging any check-in. Runs BOTH
    // halves of RiskScorer's adaptive tuning (see its own class doc comment), independently:
    //   1. Notification correlation -- whichever risk-nudge notification most recently fired (if
    //      any, and if recent enough) gets its factors nudged.
    //   2. Tag correlation -- this check-in's own selected tags get their mapped factors nudged,
    //      regardless of whether a notification fired at all.
    // A no-op for whichever half doesn't apply, not the whole call -- e.g. a check-in with no
    // recent notification but real tags still runs half 2.
    @PluginMethod
    public void recordCheckinOutcome(PluginCall call) {
        String type = call.getString("type", "");
        long checkinTimeMs = call.getDouble("timestamp", (double) System.currentTimeMillis()).longValue();
        boolean slipped = "slipped".equals(type);
        boolean resisted = "resisted".equals(type);

        String json = db().getMeta("pending_notification_factors");
        db().setMeta("pending_notification_factors", ""); // consumed either way -- never matched twice
        if (json != null && !json.isEmpty()) {
            try {
                org.json.JSONObject pending = new org.json.JSONObject(json);
                long postedAt = pending.optLong("postedAt", 0);
                long elapsed = checkinTimeMs - postedAt;
                // Skip (but still consume, above) a check-in that precedes the notification --
                // clock skew edge case -- or one too old to plausibly be a reaction to it.
                if (elapsed >= 0 && elapsed <= CORRELATION_WINDOW_MS) {
                    org.json.JSONArray factors = pending.optJSONArray("factors");
                    if (slipped) RiskScorer.adjustWeights(getContext(), factors, true);
                    else if (resisted) RiskScorer.adjustWeights(getContext(), factors, false);
                }
            } catch (org.json.JSONException e) {
                // Malformed -- nothing to correlate; already consumed above.
            }
        }

        if (slipped || resisted) {
            RiskScorer.adjustWeightsForTags(getContext(), call.getArray("tags"), slipped);
        }
        call.resolve();
    }

    // The AI read something the person wrote (a check-in note, a chat message) and judged which risk
    // factors it describes (RiskExplainer.learnFromWords). Same bounded +/-ADJUST_DELTA nudge as every
    // other path; unknown or fixed factor names are ignored by RiskScorer. The model only picks the
    // CATEGORY; this method (code) does the adjusting.
    @PluginMethod
    public void nudgeWeights(PluginCall call) {
        RiskScorer.adjustWeights(getContext(), call.getArray("factors"), call.getBoolean("increase", true));
        call.resolve();
    }

    // The user's own verdict on a risk alert, from RiskAlertView: "fair" (valid=true) reinforces the
    // factors that fired, "false alarm" (valid=false) eases off the ones they said didn't fit (or
    // all of them if they didn't narrow it down) -- the same +/-ADJUST_DELTA, bounded nudge as the
    // check-in-driven tuning above, so a direct verdict can't swing a weight any harder than that
    // can. Deliberately independent of recordCheckinOutcome (a later check-in can nudge the same
    // factors again) -- same "not deduplicated" choice as the tag half, see RiskScorer's class doc.
    // The on-device model only WRITES the explanation the user reacts to; it never decides what to
    // adjust -- nudging a number is a math problem, and a 2B model reading free text into weight
    // changes would be an unaccountable way to move them. Idempotent per alert (alertId), so a
    // double tap or a re-rendered dialog can't count twice. Resolves with the factor names that are
    // actually tunable so the UI can say truthfully what changed (SEVERE keywords are fixed).
    @PluginMethod
    public void recordRiskFeedback(PluginCall call) {
        // optLong, not call.getDouble: Capacitor's getDouble returns its default for a JS integer
        // that doesn't fit an int (a millisecond timestamp parses as a Long), so the id read as 0
        // and every verdict was silently treated as "no alert" -- found on a real phone.
        long alertId = call.getData().optLong("alertId", 0L);
        boolean valid = Boolean.TRUE.equals(call.getBoolean("valid", false));
        org.json.JSONArray adjusted = RiskScorer.applyFeedback(getContext(), alertId, call.getArray("factors"), valid);
        JSObject result = new JSObject();
        result.put("adjusted", adjusted != null ? adjusted : new com.getcapacitor.JSArray());
        result.put("duplicate", adjusted == null);
        call.resolve(result);
    }

    // Free-text feedback typed on the full-screen check-in's flag page, waiting for the on-device
    // AI -- see RiskFeedbackNotes. Consumed once (cleared on read), same as the other pending items.
    @PluginMethod
    public void getPendingFeedbackNotes(PluginCall call) {
        JSObject result = new JSObject();
        result.put("notes", RiskFeedbackNotes.takeAll(getContext()));
        call.resolve(result);
    }

    // MainActivity writes this when "Pray through <passage>" (the overlay's button, or the fallback
    // notification) opened the app: {ref, description, sig, bucket, alertId}. Consumed once, cleared on
    // read, same as the other pending items; app.js checks it before getPendingRiskAlert.
    @PluginMethod
    public void getPendingMeditation(PluginCall call) {
        String json = db().getMeta("pending_meditation");
        if (json != null) db().setMeta("pending_meditation", "");
        JSObject result = new JSObject();
        if (json != null && !json.isEmpty()) {
            try {
                result.put("meditation", new JSObject(json));
            } catch (org.json.JSONException e) {
                // Malformed -- treat as nothing pending rather than failing the call.
            }
        }
        call.resolve(result);
    }

    // For Insights -- see NotificationTracking's own comment for exactly what "sent"/"responded"
    // count. Shape: {"nightly":{"sent":N,"responded":N},"risk":{"sent":N,"responded":N}}, missing
    // a type entirely (or the whole object empty) if nothing of that type has posted yet.
    @PluginMethod
    public void getNotificationStats(PluginCall call) {
        JSObject result = new JSObject();
        try {
            result.put("stats", new JSObject(NotificationTracking.statsJson(getContext())));
        } catch (org.json.JSONException e) {
            result.put("stats", new JSObject());
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

    // ==========================================================================================
    // TEMPORARY -- backs the Testing panel (Privacy tab, bottom, clearly marked in the UI).
    // Exists only to make manually verifying background features fast during development, instead
    // of waiting up to 15 minutes for the real periodic schedule (or, for the nightly check-in,
    // until 9:30pm) or hand-triggering things over adb/CDP. Remove this whole block, the methods
    // it defines, and the UI that calls them before shipping this to a real user. See PURPOSE.md.
    // ==========================================================================================

    @PluginMethod
    public void debugRunBackgroundCheck(PluginCall call) {
        androidx.work.WorkManager.getInstance(getContext())
                .enqueue(new androidx.work.OneTimeWorkRequest.Builder(BaselineSampleWorker.class).build());
        call.resolve();
    }

    @PluginMethod
    public void debugSendNightlyCheckin(PluginCall call) {
        androidx.work.WorkManager.getInstance(getContext())
                .enqueue(new androidx.work.OneTimeWorkRequest.Builder(NightlyCheckinWorker.class)
                        .setInputData(new androidx.work.Data.Builder().putBoolean(NightlyCheckinWorker.KEY_FORCE, true).build())
                        .build());
        call.resolve();
    }

    @PluginMethod
    public void debugSendRiskNudge(PluginCall call) {
        RiskNudgeMonitor.debugForceNotify(getContext(), call.getString("packageName"), call.getInt("minutes", 0));
        call.resolve();
    }

    @PluginMethod
    public void debugClearRiskNudgeCooldown(PluginCall call) {
        RiskNudgeMonitor.debugClearCooldown(getContext());
        call.resolve();
    }

    // Peeks pending_risk_alert without consuming it (unlike getPendingRiskAlert), so testing this
    // doesn't also eat the alert RiskAlertView would otherwise show on next boot.
    @PluginMethod
    public void debugPeekPendingRiskAlert(PluginCall call) {
        JSObject result = new JSObject();
        result.put("raw", db().getMeta("pending_risk_alert"));
        call.resolve(result);
    }
}
