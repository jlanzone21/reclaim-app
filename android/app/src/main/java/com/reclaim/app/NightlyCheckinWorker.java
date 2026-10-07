package com.reclaim.app;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import androidx.work.ExistingWorkPolicy;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Locale;
import java.util.concurrent.TimeUnit;

/**
 * A once-a-day prompt around 9:30pm -- deliberately before the "Night" risk bucket (10pm-5am,
 * see RiskScorer.timeBucket) even starts, so this doubles as a preventive touchpoint, not just a
 * data-collection one. Asks how the day went; two paths from there, both landing in the same
 * CheckInStore everything else already reads from (RiskProfile, personalContext.js, Insights).
 *
 * The two paths need different plumbing, confirmed the hard way via real-device testing:
 *
 *   "Went well"   -> routed through NightlyCheckinActionReceiver (a plain broadcast), which writes
 *                    a pending "quick_resisted" flag and does nothing else -- no app UI shown. It
 *                    can't write to db.js's sql.js directly (native, WebView not loaded), so app.js
 *                    consumes and clears the flag on next boot/resume, logging the check-in then --
 *                    same pattern RiskAlertView already established for pending_risk_alert. The
 *                    flag is only ever set on an actual tap, never at post time (an earlier version
 *                    set it eagerly in doWork() itself, which would have misfired -- opening
 *                    straight to Check-In on the next unrelated app launch -- for anyone who never
 *                    tapped the notification at all).
 *   "Tell me more" (or the notification body) -> MUST use a direct PendingIntent.getActivity(),
 *                    not a receiver. An earlier version routed this through
 *                    NightlyCheckinActionReceiver too (calling ctx.startActivity() itself), but
 *                    real-device testing on a recent Android build showed the platform blocking it
 *                    outright -- logcat: "Indirect notification activity start (trampoline) from
 *                    com.reclaim.app blocked" / "Background activity launch blocked!". Modern
 *                    Android does not credit a BroadcastReceiver's own startActivity() call with
 *                    the user-tap exemption a notification's PendingIntent normally carries, even
 *                    when the receiver only runs because that tap fired it. A PendingIntent.
 *                    getActivity() built here and handed straight to the notification is exempt --
 *                    the system launches it directly. MainActivity.onCreate()/onNewIntent() reads
 *                    EXTRA_ACTION off that intent, writes the "open_checkin" flag itself, and
 *                    cancels the notification -- same flag, same app.js consumer, different native
 *                    path to get there.
 *
 * Pinned to 9:30 pm wall-clock time (NIGHTLY_HOUR/NIGHTLY_MINUTE), not "every 24 hours": this used
 * to be a 24-hour PeriodicWorkRequest with a one-time delay to the first 9:30, but WorkManager
 * repeats those relative to when the previous run actually completed, so once a single run slipped
 * (Doze, phone off) every later one stayed shifted forever -- confirmed on a real phone, where it was
 * firing at 1:54 am, exactly 24 h apart, 4.4 h late. Now each run is a one-time job that schedules its
 * own next one for the next 9:30 pm FIRST THING in doWork (so no early return can break the chain),
 * and BackgroundSamplerPlugin.enable() re-anchors it every time the app opens (which also corrects a
 * timezone change). If a run still lands more than MAX_LATE_MS after 9:30 it posts nothing -- a
 * "how was today?" at 2 am is worse than skipping one night.
 */
public class NightlyCheckinWorker extends Worker {
    // _v2: importance is locked in per channel ID the first time Android sees it -- bumping to
    // HIGH on an existing "reclaim_app_nightly_checkin" install would silently do nothing. New ID
    // forces a fresh channel; the old one is deleted below rather than left as orphaned clutter.
    static final String CHANNEL_ID = "reclaim_app_nightly_checkin_v2";
    private static final String OLD_CHANNEL_ID = "reclaim_app_nightly_checkin";
    static final int NOTIFICATION_ID = 3; // distinct from ForegroundAppMonitor's and RiskNudgeMonitor's

    // Hard-coded on purpose (the user's decision): 9:30 pm local time, every day.
    static final int NIGHTLY_HOUR = 21;
    static final int NIGHTLY_MINUTE = 30;
    private static final long MAX_LATE_MS = 3L * 60 * 60 * 1000;
    // One unique work name per target DATE, so the next run can be enqueued from inside the current one
    // (a single shared name would make KEEP drop it, or REPLACE cancel the running worker).
    private static final String UNIQUE_NAME_PREFIX = "reclaim_app_nightly_checkin_";
    private static final String LEGACY_UNIQUE_NAME = "reclaim_app_nightly_checkin"; // the old 24 h periodic
    // The Testing panel's "send nightly check-in" bypasses the lateness guard (it runs at any hour).
    static final String KEY_FORCE = "force";

    // The next NIGHTLY_HOUR:NIGHTLY_MINUTE strictly after "now" (today if still ahead, else tomorrow).
    private static Calendar nextTarget() {
        Calendar target = Calendar.getInstance();
        target.set(Calendar.HOUR_OF_DAY, NIGHTLY_HOUR);
        target.set(Calendar.MINUTE, NIGHTLY_MINUTE);
        target.set(Calendar.SECOND, 0);
        target.set(Calendar.MILLISECOND, 0);
        if (target.getTimeInMillis() <= System.currentTimeMillis()) target.add(Calendar.DATE, 1);
        return target;
    }

    // How long ago the most recent 9:30 pm was (0..24h). A run at 9:30:05 pm is seconds late; one at
    // 1:54 am is 4h24m late.
    static long latenessMs() {
        Calendar last = nextTarget();
        last.add(Calendar.DATE, -1);
        return System.currentTimeMillis() - last.getTimeInMillis();
    }

    /**
     * Schedules the next nightly check-in for the next 9:30 pm and cancels the legacy periodic job.
     * Always REPLACE, from the app-open path and from inside the worker alike: if a run ever fires BEFORE
     * its own 9:30 pm (a forced run, a clock change) the "next" target is that same date -- the same
     * unique name as the work currently running -- and KEEP would silently drop the new one and break the
     * chain. REPLACE cancels the running instance (it just finishes its current pass; its result is
     * ignored) and enqueues the fresh one.
     */
    static void scheduleNext(Context ctx) {
        WorkManager wm = WorkManager.getInstance(ctx);
        wm.cancelUniqueWork(LEGACY_UNIQUE_NAME); // no-op once it's gone
        Calendar target = nextTarget();
        long delay = target.getTimeInMillis() - System.currentTimeMillis();
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(NightlyCheckinWorker.class)
                .setInitialDelay(delay, TimeUnit.MILLISECONDS)
                .build();
        String name = UNIQUE_NAME_PREFIX + new SimpleDateFormat("yyyyMMdd", Locale.US).format(target.getTime());
        wm.enqueueUniqueWork(name, ExistingWorkPolicy.REPLACE, request);
    }

    // Read by MainActivity.onCreate()/onNewIntent() -- see class doc comment for why the "open
    // checkin" path launches the activity directly instead of going through the broadcast receiver.
    static final String EXTRA_ACTION = "nightly_action";
    static final String ACTION_OPEN_CHECKIN = "open_checkin"; // matches the app_meta value app.js expects

    // Cleared automatically if never acted on -- stays relevant most of the next day (someone
    // might reasonably answer "how was yesterday" the next morning), but should be gone well
    // before that evening's new one posts, not still sitting in the shade from the day before.
    private static final long TIMEOUT_MS = 12L * 60 * 60 * 1000;

    // Every {title, body} pair asks the same underlying question -- did today go okay or not --
    // just worded differently, so a daily notification doesn't read as the exact same robotic
    // string every single night. Picked at random per post, not by day-of-week/rotation order, so
    // it doesn't become a predictable pattern either.
    private static final String[][] MESSAGES = {
            {"How was today?", "Any struggles worth noting, or did it go well?"},
            {"Evening check-in", "How are you feeling as today wraps up?"},
            {"Quick check-in", "Rough day or a smooth one? Either way, we'd like to know."},
            {"Before you wind down", "Anything from today worth logging?"},
            {"How'd today go?", "No pressure — just checking in on you."},
            {"Checking in", "What was today like for you?"},
            {"One more thing before bed", "How are you doing tonight?"},
            {"Reflecting on today", "Good day, hard day, or somewhere in between?"},
    };

    public NightlyCheckinWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context ctx = getApplicationContext();
        // Chain the next night FIRST, before any early return below can break it.
        scheduleNext(ctx);
        if (!getInputData().getBoolean(KEY_FORCE, false) && latenessMs() > MAX_LATE_MS) {
            android.util.Log.d("NightlyCheckin", "ran " + (latenessMs() / 60000) + " min after 9:30 pm -- skipping tonight");
            return Result.success();
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return Result.success();
        }

        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return Result.success();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.deleteNotificationChannel(OLD_CHANNEL_ID);
            // HIGH, not DEFAULT: this is meant to actually be seen and acted on in the moment
            // (the timing is deliberately chosen relative to RiskScorer's Night bucket -- see class
            // doc comment), not just logged quietly in the shade the way DEFAULT would.
            nm.createNotificationChannel(new NotificationChannel(CHANNEL_ID, "Nightly check-in", NotificationManager.IMPORTANCE_HIGH));
        }

        PendingIntent openCheckIn = openCheckInIntent(ctx);
        PendingIntent wentWell = actionIntent(ctx, NightlyCheckinActionReceiver.ACTION_WENT_WELL, 1);
        String[] message = MESSAGES[new java.util.Random().nextInt(MESSAGES.length)];

        // Escalates to a full-screen intent only when the PREVIOUS nightly check-in went
        // unanswered -- see NotificationTracking's own comment. Not unconditional the way
        // RiskNudgeMonitor's already is: this prompt is a routine daily touchpoint, not a risk
        // alert, so it should only interrupt more assertively after being ignored once, not
        // every single night.
        boolean escalate = NotificationTracking.recordSentAndShouldEscalate(ctx, NotificationTracking.TYPE_NIGHTLY);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(ctx, CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(message[0])
                .setContentText(message[1])
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setContentIntent(openCheckIn)
                .addAction(0, "Went well", wentWell)
                .addAction(0, "Tell me more", openCheckIn)
                .setTimeoutAfter(TIMEOUT_MS)
                .setAutoCancel(true);

        if (escalate) {
            // Same honest limit as RiskNudgeMonitor's own use of this -- only reliably takes over
            // when the screen is off/locked, never yanks focus from something actively in use.
            builder.setFullScreenIntent(openCheckIn, true);
        }

        nm.notify(NOTIFICATION_ID, builder.build());
        return Result.success();
    }

    private static PendingIntent actionIntent(Context ctx, String action, int requestCode) {
        Intent intent = new Intent(ctx, NightlyCheckinActionReceiver.class).setAction(action);
        return PendingIntent.getBroadcast(ctx, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static PendingIntent openCheckInIntent(Context ctx) {
        Intent intent = new Intent(ctx, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra(EXTRA_ACTION, ACTION_OPEN_CHECKIN);
        return PendingIntent.getActivity(ctx, 2, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
