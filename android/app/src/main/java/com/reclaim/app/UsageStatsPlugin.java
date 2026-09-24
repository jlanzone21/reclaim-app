package com.reclaim.app;

import android.app.AppOpsManager;
import android.app.usage.UsageStats;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.Intent;
import android.os.Process;
import android.provider.Settings;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.List;

/**
 * Ported from reclaim-beta (already verified on-device there) with no logic changes -- exposes
 * Android's UsageStatsManager (app/screen foreground time) to the WebView.
 *
 * PACKAGE_USAGE_STATS is a special "app op" permission -- there is no runtime permission dialog
 * for it. The user has to grant it manually in Settings, which is why this plugin's job is split
 * into hasPermission() (check) and openPermissionSettings() (deep-link there) rather than a
 * normal request/response permission flow.
 */
@CapacitorPlugin(name = "UsageStats")
public class UsageStatsPlugin extends Plugin {

    @PluginMethod
    public void hasPermission(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", isUsageAccessGranted());
        call.resolve(result);
    }

    @PluginMethod
    public void openPermissionSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    @PluginMethod
    public void getUsageStats(PluginCall call) {
        if (!isUsageAccessGranted()) {
            call.reject("Usage access permission not granted");
            return;
        }

        long endTime = call.getLong("endTime", System.currentTimeMillis());
        long startTime = call.getLong("startTime", endTime - 24L * 60 * 60 * 1000);

        UsageStatsManager usm = (UsageStatsManager) getContext().getSystemService(Context.USAGE_STATS_SERVICE);
        List<UsageStats> stats = usm.queryUsageStats(UsageStatsManager.INTERVAL_DAILY, startTime, endTime);

        JSArray results = new JSArray();
        if (stats != null) {
            for (UsageStats us : stats) {
                if (us.getTotalTimeInForeground() <= 0) continue;
                JSObject entry = new JSObject();
                entry.put("packageName", us.getPackageName());
                entry.put("totalTimeInForegroundMs", us.getTotalTimeInForeground());
                entry.put("lastTimeUsed", us.getLastTimeUsed());
                results.put(entry);
            }
        }

        JSObject result = new JSObject();
        result.put("stats", results);
        call.resolve(result);
    }

    private boolean isUsageAccessGranted() {
        AppOpsManager appOps = (AppOpsManager) getContext().getSystemService(Context.APP_OPS_SERVICE);
        int mode = appOps.checkOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                Process.myUid(),
                getContext().getPackageName());
        return mode == AppOpsManager.MODE_ALLOWED;
    }
}
