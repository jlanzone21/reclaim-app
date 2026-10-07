package com.reclaim.app;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkInfo;
import androidx.work.WorkManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * Adapted from reclaim-beta's BackgroundSamplerPlugin: schedules BaselineSampleWorker to run
 * roughly every 15 minutes -- Android's own enforced floor for periodic WorkManager jobs -- for as
 * long as the app is installed, independent of whether it's open. Simpler than reclaim-beta's
 * version: no hashed device id to configure, since nothing here is ever sent anywhere -- there's
 * no remote row to attribute to a device. "configure" here just means "the user finished the
 * consent/permissions flow, start sampling."
 */
@CapacitorPlugin(name = "BackgroundSampler")
public class BackgroundSamplerPlugin extends Plugin {
    private static final String UNIQUE_WORK_NAME = "reclaim_app_baseline_sample";

    @PluginMethod
    public void enable(PluginCall call) {
        SharedPreferences prefs = getContext().getSharedPreferences(BaselineSampleWorker.PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit().putBoolean(BaselineSampleWorker.KEY_TRACKING_ENABLED, true).apply();

        LocalSignalsDb.getInstance(getContext()).seedDefaultAllowlistIfNeeded(getContext());

        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(BaselineSampleWorker.class, 15, TimeUnit.MINUTES).build();
        // KEEP: if a schedule already exists (e.g. the app was reopened), leave its timing alone
        // rather than restarting the interval.
        WorkManager.getInstance(getContext())
                .enqueueUniquePeriodicWork(UNIQUE_WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, request);

        // Pinned to 9:30 pm wall-clock (see NightlyCheckinWorker's class doc for why this is no longer a
        // 24 h periodic job). Re-anchored on every app open, which also corrects a timezone change.
        NightlyCheckinWorker.scheduleNext(getContext());

        call.resolve();
    }

    @PluginMethod
    public void isScheduled(PluginCall call) {
        JSObject result = new JSObject();
        try {
            List<WorkInfo> infos = WorkManager.getInstance(getContext()).getWorkInfosForUniqueWork(UNIQUE_WORK_NAME).get();
            boolean scheduled = false;
            for (WorkInfo info : infos) {
                if (!info.getState().isFinished()) {
                    scheduled = true;
                    break;
                }
            }
            result.put("scheduled", scheduled);
        } catch (Exception e) {
            result.put("scheduled", false);
        }
        call.resolve(result);
    }
}
