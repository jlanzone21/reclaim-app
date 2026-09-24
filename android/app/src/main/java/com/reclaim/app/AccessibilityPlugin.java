package com.reclaim.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.provider.Settings;
import android.text.TextUtils;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Ported from reclaim-beta. Accessibility is a special access permission like
 * PACKAGE_USAGE_STATS and notification access -- no runtime dialog, granted manually via
 * Settings.ACTION_ACCESSIBILITY_SETTINGS. TrackingAccessibilityService stores only a bare host
 * string (at this phase); this plugin checks whether it's enabled and hands that host back out,
 * discarding it once it's stale.
 */
@CapacitorPlugin(name = "Accessibility")
public class AccessibilityPlugin extends Plugin {
    private static final long FRESHNESS_WINDOW_MS = 60 * 60 * 1000; // 1hr, same window as notifications/usage

    @PluginMethod
    public void hasPermission(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", isServiceEnabled());
        call.resolve(result);
    }

    @PluginMethod
    public void openPermissionSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    @PluginMethod
    public void getDetectedDomain(PluginCall call) {
        JSObject result = new JSObject();
        if (!isServiceEnabled()) {
            call.resolve(result);
            return;
        }

        SharedPreferences prefs = getContext().getSharedPreferences(
                TrackingAccessibilityService.PREFS_NAME, Context.MODE_PRIVATE);
        long detectedAt = prefs.getLong(TrackingAccessibilityService.KEY_DETECTED_AT, 0);
        if (detectedAt > 0 && System.currentTimeMillis() - detectedAt <= FRESHNESS_WINDOW_MS) {
            result.put("domain", prefs.getString(TrackingAccessibilityService.KEY_DOMAIN, null));
        }
        call.resolve(result);
    }

    private boolean isServiceEnabled() {
        String enabled = Settings.Secure.getString(
                getContext().getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        if (TextUtils.isEmpty(enabled)) return false;

        String flatComponentName = getContext().getPackageName() + "/" + TrackingAccessibilityService.class.getName();
        for (String piece : enabled.split(":")) {
            if (piece.equalsIgnoreCase(flatComponentName)) return true;
        }
        return false;
    }
}
