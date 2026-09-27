package com.reclaim.app;

import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Handles the "Went well" action on NightlyCheckinWorker's notification -- a plain broadcast, no
 * app UI. The "Tell me more" / body-tap path does NOT go through here; see NightlyCheckinWorker's
 * class comment for why that one needs a direct Activity PendingIntent instead (modern Android
 * blocks a BroadcastReceiver from launching an activity itself, even in direct response to a
 * notification tap -- confirmed via real-device testing, not a theoretical concern).
 */
public class NightlyCheckinActionReceiver extends BroadcastReceiver {
    static final String ACTION_WENT_WELL = "com.reclaim.app.NIGHTLY_CHECKIN_WENT_WELL";

    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (!ACTION_WENT_WELL.equals(intent.getAction())) return;

        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(NightlyCheckinWorker.NOTIFICATION_ID);

        // No app UI at all -- app.js logs the actual check-in on next boot/resume (see its own
        // comment) since this native receiver can't reach db.js's sql.js directly.
        LocalSignalsDb.getInstance(ctx).setMeta("pending_nightly_action", "quick_resisted");
    }
}
