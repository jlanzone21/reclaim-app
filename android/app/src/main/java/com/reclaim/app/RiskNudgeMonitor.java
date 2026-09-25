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
 * verification tool. Two things happen when it fires: a notification with a "Call [name]" action
 * that opens the phone's own dialer pre-filled -- same tel:-only, on-device, user-confirms-the-
 * call choice as the crisis modal (never auto-dials, never sends anything itself) -- and an
 * attempt to actually interrupt, via setFullScreenIntent(), the same mechanism calls/alarms use.
 *
 * Honest limit on that second part, not worked around: Android deliberately blocks a background
 * app from stealing focus from whatever's actively in use, so a full-screen intent only reliably
 * takes over when the screen is off/locked (opens the app instead of the lock screen) -- it does
 * NOT yank focus away from another app you're actively using. That's Android's own anti-abuse
 * design, not a bug here.
 *
 * The notification/lock-screen text is deliberately generic (GENERIC_TEXT below) -- never names
 * the app or pattern that triggered it, since anyone glancing at a locked phone could see that
 * text. The specific "here's what we noticed" detail (RiskScorer's userReasons) is written to
 * LocalSignalsDb's app_meta instead, read back and shown by app.js only once the app is actually
 * open -- which requires deliberately unlocking the phone first. See PURPOSE.md.
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

        postNotification(ctx, session.packageName, result);
    }

    // TEMPORARY test hook -- called from the Testing panel (Privacy tab, see PURPOSE.md), not
    // part of the real detection path. Runs the real scorer against whatever's actually
    // foreground right now, but skips the score threshold and the dedup check so a real
    // notification can be seen on demand instead of waiting for real conditions to align.
    static void debugForceNotify(Context ctx) {
        Session session = currentSession(ctx);
        String packageName = session != null ? session.packageName : ctx.getPackageName();
        long sessionMinutes = session != null ? (System.currentTimeMillis() - session.startedAt) / 60000 : 0;
        RiskScorer.Result result = RiskScorer.score(ctx, packageName, sessionMinutes);
        Log.d(TAG, "[debug] score=" + result.score + " threshold=" + result.threshold + " [" + result.reason + "]");
        postNotification(ctx, packageName, result);
    }

    // TEMPORARY test hook -- clears the per-session dedup marker so a repeat test isn't silently
    // swallowed by "already notified for this session" while iterating.
    static void debugClearCooldown(Context ctx) {
        ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit().clear().apply();
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

    // Deliberately generic everywhere it could be seen before the phone is unlocked (the
    // notification banner, and the lock screen if a full-screen intent actually takes over) --
    // never names the app or the specific pattern. The real "here's what we noticed" detail only
    // shows once the app is actually open, which requires deliberately unlocking first. See
    // PURPOSE.md's "Decisions worth remembering".
    private static final String GENERIC_TEXT = "Reclaim wants to check in with you.";

    private static void postNotification(Context ctx, String packageName, RiskScorer.Result result) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // HIGH, not DEFAULT: a full-screen intent needs a high-importance channel to actually
            // heads-up/take over -- see the class doc comment on what this can and can't do.
            nm.createNotificationChannel(new NotificationChannel(CHANNEL_ID, "Reclaim", NotificationManager.IMPORTANCE_HIGH));
        }

        LocalSignalsDb db = LocalSignalsDb.getInstance(ctx);
        db.setMeta("pending_risk_alert", buildPendingAlertJson(ctx, packageName, result));

        // Tapping the notification body (not the call action) opens the app -- app.js checks for
        // the pending alert above on boot and shows the detail screen instead of landing on Chat.
        Intent openApp = new Intent(ctx, MainActivity.class);
        openApp.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent openAppIntent = PendingIntent.getActivity(
                ctx, 0, openApp, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(ctx, CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("Reclaim")
                .setContentText(GENERIC_TEXT)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_REMINDER)
                .setContentIntent(openAppIntent)
                // Real, honest limit -- see the class doc comment: only reliably takes over when
                // the screen is off/locked. Android won't let a background app steal focus from
                // one actively in use, by design, and this doesn't try to work around that.
                .setFullScreenIntent(openAppIntent, true)
                .setAutoCancel(true);

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

    // The specific, plain-language detail (which app, which reasons) never appears in the
    // notification itself -- only here, read back by app.js once the app is actually open. See
    // GENERIC_TEXT above.
    private static String buildPendingAlertJson(Context ctx, String packageName, RiskScorer.Result result) {
        try {
            org.json.JSONObject alert = new org.json.JSONObject();
            alert.put("appLabel", appLabel(ctx, packageName));
            alert.put("reasons", result.userReasons);
            alert.put("occurredAt", LocalSignalsDb.isoNow());
            return alert.toString();
        } catch (org.json.JSONException e) {
            return null;
        }
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
