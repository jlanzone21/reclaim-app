package com.reclaim.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

/**
 * Ported from reclaim-beta. Records only which app most recently posted a notification, never the
 * notification's own text -- the same "package name only" boundary NotificationAccessPlugin and
 * the periodic sampler rely on.
 */
public class RecentNotificationListenerService extends NotificationListenerService {
    static final String PREFS_NAME = "reclaim_app_notifications";
    static final String KEY_PACKAGE = "recent_package";
    static final String KEY_POSTED_AT = "recent_posted_at";

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        String pkg = sbn.getPackageName();
        if (pkg == null || pkg.equals(getPackageName())) return;

        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit()
                .putString(KEY_PACKAGE, pkg)
                .putLong(KEY_POSTED_AT, System.currentTimeMillis())
                .apply();
    }
}
