package com.reclaim.app;

import android.app.AppOpsManager;
import android.app.KeyguardManager;
import android.app.usage.UsageStats;
import android.app.usage.UsageStatsManager;
import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.location.Location;
import android.os.PowerManager;
import android.os.Process;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.util.Calendar;
import java.util.List;

/**
 * Ported from reclaim-beta's BaselineSampleWorker (verified on-device there), storing locally in
 * LocalSignalsDb instead of posting to Supabase -- the whole point of doing this in reclaim-app.
 * Runs on WorkManager's schedule (see BackgroundSamplerPlugin) -- the app and its WebView may be
 * fully closed when this fires, so it reads usage stats/location straight from the Android APIs
 * and writes straight to LocalSignalsDb rather than through the JS bridge (nothing here can call
 * back into JS).
 *
 * Also folds in whatever TrackingAccessibilityService (browser domain) and
 * RecentNotificationListenerService (notifying app) last cached, so a browsed site or a triggering
 * app shows up automatically on the next periodic tick.
 */
public class BaselineSampleWorker extends Worker {
    private static final String TAG = "BaselineSampleWorker";
    private static final long FRESHNESS_WINDOW_MS = 60 * 60 * 1000; // 1hr, same as the JS-facing plugins

    static final String PREFS_NAME = "reclaim_app_tracking";
    static final String KEY_TRACKING_ENABLED = "tracking_enabled";

    public BaselineSampleWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        SharedPreferences prefs = getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        // Consent/permissions setup hasn't finished yet -- nothing to sample.
        if (!prefs.getBoolean(KEY_TRACKING_ENABLED, false)) {
            Log.d(TAG, "tracking not enabled yet, skipping");
            return Result.success();
        }

        // Only sample while the phone is actually in use -- screen on AND unlocked. A tick while
        // it's asleep or sitting locked in someone's pocket is a device-state row, not a
        // behavioral one, and just fills the table with rows that are null across the board.
        if (!isInActiveUse()) {
            Log.d(TAG, "screen off or locked, skipping");
            return Result.success();
        }

        // Debug/verification helper -- see ForegroundAppMonitor's own comment.
        ForegroundAppMonitor.checkAndNotify(getApplicationContext());

        try {
            ContentValues row = new ContentValues();
            row.put("sampled_at", LocalSignalsDb.isoNow());
            row.put("local_hour", Calendar.getInstance().get(Calendar.HOUR_OF_DAY));

            String topApp = topRecentApp();
            if (topApp != null) row.put("top_app_package", topApp);

            String domain = cachedDetectedDomain();
            if (domain != null) row.put("detected_domain", domain);

            String notifier = cachedRecentNotificationPackage();
            if (notifier != null) row.put("recent_notification_package", notifier);

            Location location = DeviceLocation.bestKnown(getApplicationContext());
            if (location != null) {
                row.put("coarse_lat", DeviceLocation.roundTo(location.getLatitude(), 1));
                row.put("coarse_lon", DeviceLocation.roundTo(location.getLongitude(), 1));
                if (DeviceLocation.hasPreciseAccess(getApplicationContext())) {
                    row.put("precise_lat", DeviceLocation.roundTo(location.getLatitude(), 6));
                    row.put("precise_lon", DeviceLocation.roundTo(location.getLongitude(), 6));
                }
            }

            long id = LocalSignalsDb.getInstance(getApplicationContext()).insertUsageSample(row);
            Log.d(TAG, "stored usage sample, id=" + id);
            return id >= 0 ? Result.success() : Result.retry();
        } catch (Exception e) {
            Log.e(TAG, "sample failed", e);
            return Result.retry();
        }
    }

    private boolean isInActiveUse() {
        PowerManager pm = (PowerManager) getApplicationContext().getSystemService(Context.POWER_SERVICE);
        KeyguardManager km = (KeyguardManager) getApplicationContext().getSystemService(Context.KEYGUARD_SERVICE);
        boolean screenOn = pm != null && pm.isInteractive();
        boolean unlocked = km == null || !km.isKeyguardLocked();
        return screenOn && unlocked;
    }

    private boolean hasUsageAccess() {
        AppOpsManager appOps = (AppOpsManager) getApplicationContext().getSystemService(Context.APP_OPS_SERVICE);
        int mode = appOps.checkOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                Process.myUid(),
                getApplicationContext().getPackageName());
        return mode == AppOpsManager.MODE_ALLOWED;
    }

    private String topRecentApp() {
        if (!hasUsageAccess()) return null;
        UsageStatsManager usm = (UsageStatsManager) getApplicationContext().getSystemService(Context.USAGE_STATS_SERVICE);
        long end = System.currentTimeMillis();
        long start = end - 60L * 60 * 1000;
        List<UsageStats> stats = usm.queryUsageStats(UsageStatsManager.INTERVAL_DAILY, start, end);
        if (stats == null || stats.isEmpty()) return null;
        // Excluded: being in Reclaim itself isn't a distraction signal, and it otherwise tends to
        // win this "most foreground time in the last hour" comparison during normal use of the app.
        // The launcher is excluded too -- going home isn't "using an app".
        String ownPackage = getApplicationContext().getPackageName();
        UsageStats top = null;
        for (UsageStats s : stats) {
            if (s.getTotalTimeInForeground() <= 0) continue;
            if (s.getPackageName().equals(ownPackage)) continue;
            if (LocalSignalsDb.isLauncherPackage(getApplicationContext(), s.getPackageName())) continue;
            if (top == null || s.getTotalTimeInForeground() > top.getTotalTimeInForeground()) top = s;
        }
        return top != null ? top.getPackageName() : null;
    }

    // Whatever TrackingAccessibilityService last saw, if it's recent enough to still mean
    // "still there" rather than a stale leftover from earlier.
    private String cachedDetectedDomain() {
        SharedPreferences prefs = getApplicationContext().getSharedPreferences(
                TrackingAccessibilityService.PREFS_NAME, Context.MODE_PRIVATE);
        long detectedAt = prefs.getLong(TrackingAccessibilityService.KEY_DETECTED_AT, 0);
        if (detectedAt == 0 || System.currentTimeMillis() - detectedAt > FRESHNESS_WINDOW_MS) return null;
        return prefs.getString(TrackingAccessibilityService.KEY_DOMAIN, null);
    }

    private String cachedRecentNotificationPackage() {
        SharedPreferences prefs = getApplicationContext().getSharedPreferences(
                RecentNotificationListenerService.PREFS_NAME, Context.MODE_PRIVATE);
        long postedAt = prefs.getLong(RecentNotificationListenerService.KEY_POSTED_AT, 0);
        if (postedAt == 0 || System.currentTimeMillis() - postedAt > FRESHNESS_WINDOW_MS) return null;
        return prefs.getString(RecentNotificationListenerService.KEY_PACKAGE, null);
    }
}
