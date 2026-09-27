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
import androidx.work.Worker;
import androidx.work.WorkerParameters;

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
 * Scheduled from BackgroundSamplerPlugin.enable() alongside the periodic sampler. WorkManager's
 * periodic jobs aren't wall-clock-exact -- each run is scheduled relative to when the previous one
 * actually completed, which can drift over many days under Doze/battery optimization. Fine for a
 * "roughly evening" reminder; not something this pretends to guarantee to the minute.
 */
public class NightlyCheckinWorker extends Worker {
    // _v2: importance is locked in per channel ID the first time Android sees it -- bumping to
    // HIGH on an existing "reclaim_app_nightly_checkin" install would silently do nothing. New ID
    // forces a fresh channel; the old one is deleted below rather than left as orphaned clutter.
    static final String CHANNEL_ID = "reclaim_app_nightly_checkin_v2";
    private static final String OLD_CHANNEL_ID = "reclaim_app_nightly_checkin";
    static final int NOTIFICATION_ID = 3; // distinct from ForegroundAppMonitor's and RiskNudgeMonitor's

    // Read by MainActivity.onCreate()/onNewIntent() -- see class doc comment for why the "open
    // checkin" path launches the activity directly instead of going through the broadcast receiver.
    static final String EXTRA_ACTION = "nightly_action";
    static final String ACTION_OPEN_CHECKIN = "open_checkin"; // matches the app_meta value app.js expects

    public NightlyCheckinWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context ctx = getApplicationContext();
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

        NotificationCompat.Builder builder = new NotificationCompat.Builder(ctx, CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("How was today?")
                .setContentText("Any struggles worth noting, or did it go well?")
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setContentIntent(openCheckIn)
                .addAction(0, "Went well", wentWell)
                .addAction(0, "Tell me more", openCheckIn)
                .setAutoCancel(true);

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
