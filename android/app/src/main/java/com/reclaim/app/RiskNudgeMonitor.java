package com.reclaim.app;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.usage.UsageEvents;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

/**
 * The plan's "risk analysis algorithm," phase one: real multi-factor scoring (RiskScorer), not a
 * single duration threshold. Goal per the plan is prediction, not reaction -- notice a lead-up
 * pattern (a flagged trigger app, during a time that's historically or self-reportedly hard for
 * this person) and intercept before a slip, rather than wait for direct evidence one is already
 * happening. See RiskScorer for the actual weights and reasoning.
 *
 * Runs from BaselineSampleWorker at the same ~15-minute cadence as ForegroundAppMonitor, which
 * this reuses the session-detection shape of, but is a real feature, not that class's
 * verification tool: it asks whether they want to reach out to their accountability partner, with
 * a notification action that opens the phone's own dialer pre-filled with that number -- same
 * tel:-only, on-device, user-confirms-the-call choice as the crisis modal (never auto-dials,
 * never sends anything itself). See PURPOSE.md.
 */
@SuppressWarnings("deprecation") // UsageEvents.Event.MOVE_TO_FOREGROUND/BACKGROUND, see ForegroundAppMonitor
final class RiskNudgeMonitor {
    private static final String TAG = "RiskNudgeMonitor";
    private static final long QUERY_WINDOW_MS = 2 * 60 * 60 * 1000;
    private static final String PREFS_NAME = "reclaim_app_risk_nudge";
    private static final String KEY_LAST_PACKAGE = "last_notified_package";
    private static final String KEY_LAST_SESSION_START = "last_notified_session_start";
    private static final String CHANNEL_ID = "reclaim_app_nudge";
    private static final int NOTIFICATION_ID = 2; // distinct from ForegroundAppMonitor's

    private RiskNudgeMonitor() {}

    static void checkAndNotify(Context ctx) {
        if (!hasUsageAccess(ctx) || !hasNotificationPermission(ctx)) return;

        Session session = currentSession(ctx);
        if (session == null) return;

        long sessionMinutes = (System.currentTimeMillis() - session.startedAt) / 60000;
        RiskScorer.Result result = RiskScorer.score(ctx, session.packageName, sessionMinutes);
        Log.d(TAG, "score=" + result.score + " threshold=" + result.threshold + " [" + result.reason + "]");
        if (!result.triggers()) return;

        SharedPreferences prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        // Only once per continuous session, keyed by its exact start time -- otherwise every
        // ~15-minute tick would re-notify for as long as the same app stays in the foreground.
        if (session.packageName.equals(prefs.getString(KEY_LAST_PACKAGE, null))
                && session.startedAt == prefs.getLong(KEY_LAST_SESSION_START, 0)) {
            return;
        }
        // Written only after the permission check above passes -- otherwise a session that first
        // crosses the threshold before notification permission is granted would burn this
        // one-shot dedup slot and silently never notify for it, even after granting permission.
        prefs.edit()
                .putString(KEY_LAST_PACKAGE, session.packageName)
                .putLong(KEY_LAST_SESSION_START, session.startedAt)
                .apply();

        postNotification(ctx);
    }

    private static boolean hasNotificationPermission(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true;
        return ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    private static final class Session {
        final String packageName;
        final long startedAt;
        Session(String packageName, long startedAt) {
            this.packageName = packageName;
            this.startedAt = startedAt;
        }
    }

    // Same event walk as ForegroundAppMonitor.currentSession, plus: the launcher never counts as
    // a session at all -- going home doesn't just fail the threshold, it doesn't even start the
    // clock, so a phone left on the home screen for 20 minutes never triggers this.
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
                String pkg = event.getPackageName();
                if (pkg != null && LocalSignalsDb.isLauncherPackage(ctx, pkg)) {
                    currentPackage = null;
                } else {
                    currentPackage = pkg;
                    sessionStart = event.getTimeStamp();
                }
            } else if (event.getEventType() == UsageEvents.Event.MOVE_TO_BACKGROUND
                    && event.getPackageName() != null
                    && event.getPackageName().equals(currentPackage)) {
                currentPackage = null;
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

    private static void postNotification(Context ctx) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL_ID, "Reclaim", NotificationManager.IMPORTANCE_DEFAULT));
        }

        // Tapping the notification body (not the call action) just opens the app -- Chat is the
        // default view, so that's "talk to the AI instead" without any extra routing needed.
        Intent openApp = new Intent(ctx, MainActivity.class);
        openApp.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent openAppIntent = PendingIntent.getActivity(
                ctx, 0, openApp, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(ctx, CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("Reclaim")
                .setContentText("This can be a hard moment. Want to reach out to your accountability partner?")
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setContentIntent(openAppIntent)
                .setAutoCancel(true);

        LocalSignalsDb db = LocalSignalsDb.getInstance(ctx);
        String phone = db.getMeta("accountability_phone");
        if (phone != null && !phone.trim().isEmpty()) {
            // ACTION_DIAL, not ACTION_CALL: opens the phone's own dialer pre-filled, doesn't place
            // the call itself -- the same "opens native communication, never sends anything"
            // choice as the crisis modal's tel: links, and needs no extra runtime permission.
            Intent dial = new Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + phone.trim()));
            PendingIntent callIntent = PendingIntent.getActivity(
                    ctx, 1, dial, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            String name = db.getMeta("accountability_name");
            String label = "Call " + (name != null && !name.trim().isEmpty() ? name.trim() : "them");
            builder.addAction(0, label, callIntent);
        }

        nm.notify(NOTIFICATION_ID, builder.build());
        Log.d(TAG, "posted risk nudge notification");
    }
}
