package com.reclaim.app;

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
    }
}
