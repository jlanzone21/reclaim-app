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

import java.util.Calendar;
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
    private static final String NIGHTLY_WORK_NAME = "reclaim_app_nightly_checkin";
    private static final int NIGHTLY_HOUR = 21;
    private static final int NIGHTLY_MINUTE = 30;

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

        PeriodicWorkRequest nightlyRequest = new PeriodicWorkRequest.Builder(NightlyCheckinWorker.class, 24, TimeUnit.HOURS)
                .setInitialDelay(millisUntilNext(NIGHTLY_HOUR, NIGHTLY_MINUTE), TimeUnit.MILLISECONDS)
                .build();
        WorkManager.getInstance(getContext())
                .enqueueUniquePeriodicWork(NIGHTLY_WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, nightlyRequest);

        call.resolve();
    }

    // How long until the next occurrence of NIGHTLY_HOUR:NIGHTLY_MINUTE local time -- today if
    // that hasn't passed yet, otherwise tomorrow. WorkManager's setInitialDelay only accepts a
    // duration, not a wall-clock time, so this is how a "daily at 9:30pm" schedule gets built from
    // a plain 24-hour period.
    private static long millisUntilNext(int hour, int minute) {
        Calendar target = Calendar.getInstance();
        target.set(Calendar.HOUR_OF_DAY, hour);
        target.set(Calendar.MINUTE, minute);
        target.set(Calendar.SECOND, 0);
        target.set(Calendar.MILLISECOND, 0);
        if (target.getTimeInMillis() <= System.currentTimeMillis()) {
            target.add(Calendar.DATE, 1);
        }
        return target.getTimeInMillis() - System.currentTimeMillis();
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
