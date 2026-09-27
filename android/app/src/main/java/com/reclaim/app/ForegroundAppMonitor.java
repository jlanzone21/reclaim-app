package com.reclaim.app;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.usage.UsageEvents;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

/**
 * Ported from reclaim-beta (verified on-device there, including the app-name resolution): called
 * from BaselineSampleWorker at the same ~15-minute cadence, checks whether the CURRENTLY
 * foreground app has been foreground continuously for 1+ hour (via UsageEvents, the same
 * PACKAGE_USAGE_STATS access UsageStatsPlugin already uses -- no new scope), and if so posts one
 * local notification naming that app, asking the user to confirm it. This is a verification tool
 * for whether the usage-tracking signal lines up with what the user actually experienced -- a
 * useful sanity check independent of anything Insights shows.
 *
 * Deliberately not a general activity log: it reports a single yes/no question about the current
 * session, never a history, and never anything beyond which app and how long.
 */
@SuppressWarnings("deprecation") // UsageEvents.Event.MOVE_TO_FOREGROUND/BACKGROUND — the API 29+ replacements (ACTIVITY_RESUMED/PAUSED) don't exist below that, and minSdk here is 24
final class ForegroundAppMonitor {
    private static final String TAG = "ForegroundAppMonitor";
    private static final long SESSION_THRESHOLD_MS = 60 * 60 * 1000;
    private static final long QUERY_WINDOW_MS = 2 * 60 * 60 * 1000; // wider than the threshold so a session start is never missed
    private static final String PREFS_NAME = "reclaim_app_session_notify";
    private static final String KEY_LAST_PACKAGE = "last_notified_package";
    private static final String KEY_LAST_SESSION_START = "last_notified_session_start";
    // _v2: importance is locked in per channel ID the first time Android sees it -- see
    // NightlyCheckinWorker's matching comment for why this needed a new ID, not just a new value.
    private static final String CHANNEL_ID = "reclaim_app_debug_v2";
    private static final String OLD_CHANNEL_ID = "reclaim_app_debug";
    private static final int NOTIFICATION_ID = 1;

    private ForegroundAppMonitor() {}

    static void checkAndNotify(Context ctx) {
        if (!hasUsageAccess(ctx)) return;

        Session session = currentSession(ctx);
        if (session == null) return;

        long elapsed = System.currentTimeMillis() - session.startedAt;
        if (elapsed < SESSION_THRESHOLD_MS) return;

        SharedPreferences prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        // Only once per continuous session, keyed by its exact start time -- otherwise every
        // ~15-minute tick would re-notify for as long as the same app stays in the foreground.
        if (session.packageName.equals(prefs.getString(KEY_LAST_PACKAGE, null))
                && session.startedAt == prefs.getLong(KEY_LAST_SESSION_START, 0)) {
            return;
        }
        prefs.edit()
                .putString(KEY_LAST_PACKAGE, session.packageName)
                .putLong(KEY_LAST_SESSION_START, session.startedAt)
                .apply();

        postNotification(ctx, session.packageName);
    }

    private static final class Session {
        final String packageName;
        final long startedAt;
        Session(String packageName, long startedAt) {
            this.packageName = packageName;
            this.startedAt = startedAt;
        }
    }

    // Walks recent foreground/background transitions to find which app, if any, is foreground
    // right now and since when -- null if the trail ends in a background event (nothing is
    // foreground) or there's no usable history in the window.
    private static Session currentSession(Context ctx) {
        UsageStatsManager usm = (UsageStatsManager) ctx.getSystemService(Context.USAGE_STATS_SERVICE);
        if (usm == null) return null;
        long end = System.currentTimeMillis();
        UsageEvents events = usm.queryEvents(end - QUERY_WINDOW_MS, end);

        String currentPackage = null;
        long sessionStart = 0;
        UsageEvents.Event event = new UsageEvents.Event();
        while (events.hasNextEvent()) {
            events.getNextEvent(event);
            if (event.getEventType() == UsageEvents.Event.MOVE_TO_FOREGROUND) {
                currentPackage = event.getPackageName();
                sessionStart = event.getTimeStamp();
            } else if (event.getEventType() == UsageEvents.Event.MOVE_TO_BACKGROUND
                    && event.getPackageName() != null
                    && event.getPackageName().equals(currentPackage)) {
                currentPackage = null; // this session ended before another one started
            }
        }
        return currentPackage != null ? new Session(currentPackage, sessionStart) : null;
    }

    private static boolean hasUsageAccess(Context ctx) {
        android.app.AppOpsManager appOps = (android.app.AppOpsManager) ctx.getSystemService(Context.APP_OPS_SERVICE);
        int mode = appOps.checkOpNoThrow(
                android.app.AppOpsManager.OPSTR_GET_USAGE_STATS,
                android.os.Process.myUid(),
                ctx.getPackageName());
        return mode == android.app.AppOpsManager.MODE_ALLOWED;
    }

    private static void postNotification(Context ctx, String packageName) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            Log.d(TAG, "session threshold hit, but no notification permission -- skipping");
            return;
        }
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.deleteNotificationChannel(OLD_CHANNEL_ID);
            nm.createNotificationChannel(new NotificationChannel(CHANNEL_ID, "Usage verification", NotificationManager.IMPORTANCE_HIGH));
        }
        String appLabel = appLabel(ctx, packageName);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(ctx, CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("Reclaim")
                .setContentText("It looks like you've been on " + appLabel + " for an hour. Is that correct?")
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true);
        nm.notify(NOTIFICATION_ID, builder.build());
        Log.d(TAG, "posted 1-hour session notification for " + appLabel);
    }

    // Falls back to the raw package name if the app was uninstalled between detecting the
    // session and posting the notification, or its label can't be resolved for any reason.
    private static String appLabel(Context ctx, String packageName) {
        try {
            PackageManager pm = ctx.getPackageManager();
            return pm.getApplicationLabel(pm.getApplicationInfo(packageName, 0)).toString();
        } catch (PackageManager.NameNotFoundException e) {
            return packageName;
        }
    }
}
