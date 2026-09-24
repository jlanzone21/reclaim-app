package com.reclaim.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.provider.Settings;

import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Ported from reclaim-beta. Notification access is a special app-op permission like
 * PACKAGE_USAGE_STATS (see UsageStatsPlugin) -- no runtime dialog, granted manually via
 * Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS. The listener itself
 * (RecentNotificationListenerService) records only a package name; this plugin just checks
 * whether it's enabled and hands that package back out, discarding it once it's stale.
 */
@CapacitorPlugin(name = "NotificationAccess")
public class NotificationAccessPlugin extends Plugin {
    private static final long FRESHNESS_WINDOW_MS = 60 * 60 * 1000; // 1hr, same window used elsewhere

    @PluginMethod
    public void hasPermission(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", isListenerEnabled());
        call.resolve(result);
    }

    @PluginMethod
    public void openPermissionSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    @PluginMethod
    public void getRecentPackage(PluginCall call) {
        JSObject result = new JSObject();
        if (!isListenerEnabled()) {
            call.resolve(result);
            return;
        }

        SharedPreferences prefs = getContext().getSharedPreferences(
                RecentNotificationListenerService.PREFS_NAME, Context.MODE_PRIVATE);
        long postedAt = prefs.getLong(RecentNotificationListenerService.KEY_POSTED_AT, 0);
        if (postedAt > 0 && System.currentTimeMillis() - postedAt <= FRESHNESS_WINDOW_MS) {
            result.put("packageName", prefs.getString(RecentNotificationListenerService.KEY_PACKAGE, null));
        }
        call.resolve(result);
    }

    private boolean isListenerEnabled() {
        return NotificationManagerCompat.getEnabledListenerPackages(getContext())
                .contains(getContext().getPackageName());
    }
}
