package com.reclaim.app;

import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(UsageStatsPlugin.class);
        registerPlugin(BackgroundSamplerPlugin.class);
        registerPlugin(NotificationAccessPlugin.class);
        registerPlugin(AccessibilityPlugin.class);
        registerPlugin(NearbyDevicesPlugin.class);
        registerPlugin(LocationAlwaysPlugin.class);
        registerPlugin(NotifyPlugin.class);
        registerPlugin(LocalSignalsPlugin.class);
        super.onCreate(savedInstanceState);
        handleNotificationIntent(getIntent());
    }

    // singleTask means a notification body tap while the app is already alive delivers here
    // instead of onCreate() -- see NightlyCheckinWorker's class comment for why both notification
    // types' "open the app" intents are direct PendingIntent.getActivity()s rather than routed
    // through a receiver.
    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleNotificationIntent(intent);
    }

    private void handleNotificationIntent(Intent intent) {
        if (intent == null) return;
        handleNightlyIntent(intent);
        handleRiskIntent(intent);
    }

    private void handleNightlyIntent(Intent intent) {
        String action = intent.getStringExtra(NightlyCheckinWorker.EXTRA_ACTION);
        if (!NightlyCheckinWorker.ACTION_OPEN_CHECKIN.equals(action)) return;

        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(NightlyCheckinWorker.NOTIFICATION_ID);
        LocalSignalsDb.getInstance(this).setMeta("pending_nightly_action", "open_checkin");
        NotificationTracking.recordResponded(this, NotificationTracking.TYPE_NIGHTLY);
        // Consume the extra so backgrounding and returning to this same task later (a plain
        // resume, no new tap) doesn't re-trigger this from a stale onCreate() intent.
        intent.removeExtra(NightlyCheckinWorker.EXTRA_ACTION);
    }

    private void handleRiskIntent(Intent intent) {
        String action = intent.getStringExtra(RiskNudgeMonitor.EXTRA_ACTION);
        if (!RiskNudgeMonitor.ACTION_OPEN.equals(action)) return;

        // Explicit cancel, not just relying on setAutoCancel(true) -- confirmed on-device that
        // autoCancel doesn't reliably fire when this intent is invoked via the full-screen
        // intent's own auto-launch (screen idle) rather than a real shade tap, which left the
        // notification tappable again afterward and double-invoked this handler.
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(RiskNudgeMonitor.NOTIFICATION_ID);
        NotificationTracking.recordResponded(this, NotificationTracking.TYPE_RISK);
        // Nothing else to do here -- unlike the nightly path, the risk alert's own pending-flag
        // (pending_risk_alert) is already written at post time and consumed by RiskAlertView on
        // boot/resume, not gated on this extra. This just records the response and consumes the
        // extra itself, same reasoning as the nightly path.
        intent.removeExtra(RiskNudgeMonitor.EXTRA_ACTION);
    }
}
