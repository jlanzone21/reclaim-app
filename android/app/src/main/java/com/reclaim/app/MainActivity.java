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
        handleNightlyIntent(getIntent());
    }

    // singleTask means a "Tell me more" tap while the app is already alive delivers here instead
    // of onCreate() -- see NightlyCheckinWorker's class comment for why this intent is a direct
    // PendingIntent.getActivity() rather than routed through a receiver.
    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleNightlyIntent(intent);
    }

    private void handleNightlyIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getStringExtra(NightlyCheckinWorker.EXTRA_ACTION);
        if (!NightlyCheckinWorker.ACTION_OPEN_CHECKIN.equals(action)) return;

        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(NightlyCheckinWorker.NOTIFICATION_ID);
        LocalSignalsDb.getInstance(this).setMeta("pending_nightly_action", "open_checkin");
        // Consume the extra so backgrounding and returning to this same task later (a plain
        // resume, no new tap) doesn't re-trigger this from a stale onCreate() intent.
        intent.removeExtra(NightlyCheckinWorker.EXTRA_ACTION);
    }
}
