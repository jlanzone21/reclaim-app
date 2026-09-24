package com.reclaim.app;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanResult;
import android.content.Context;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Ported from reclaim-beta (verified on-device there). Counts distinct nearby Bluetooth LE
 * devices during a short scan and buckets the count (0 / 1-2 / 3-5 / 6+) -- a device's address is
 * only ever used in-memory, for this one moment, to dedupe the count; it's never stored or
 * transmitted.
 *
 * BLUETOOTH_SCAN (API 31+) is declared in the manifest with usesPermissionFlags="neverForLocation",
 * since this plugin never uses scan results to position anything -- that's what lets modern
 * devices skip ACCESS_FINE_LOCATION entirely. Below API 31, BLE scanning has no permission of its
 * own and relies on ACCESS_FINE_LOCATION instead, which alias() below picks by SDK version.
 */
@CapacitorPlugin(
    name = "NearbyDevices",
    permissions = {
        @Permission(strings = { Manifest.permission.BLUETOOTH_SCAN }, alias = "scan"),
        @Permission(strings = { Manifest.permission.ACCESS_FINE_LOCATION }, alias = "scanLegacy")
    }
)
public class NearbyDevicesPlugin extends Plugin {
    private static final long SCAN_DURATION_MS = 3000;

    @PluginMethod
    public void hasPermission(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", getPermissionState(alias()) == PermissionState.GRANTED);
        call.resolve(result);
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (getPermissionState(alias()) == PermissionState.GRANTED) {
            JSObject result = new JSObject();
            result.put("granted", true);
            call.resolve(result);
            return;
        }
        requestPermissionForAlias(alias(), call, "permissionCallback");
    }

    @PermissionCallback
    private void permissionCallback(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", getPermissionState(alias()) == PermissionState.GRANTED);
        call.resolve(result);
    }

    @PluginMethod
    public void getNearbyDeviceBucket(PluginCall call) {
        if (getPermissionState(alias()) != PermissionState.GRANTED) {
            call.reject("Nearby devices permission not granted");
            return;
        }

        BluetoothManager manager = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        BluetoothAdapter adapter = manager != null ? manager.getAdapter() : null;
        BluetoothLeScanner scanner = adapter != null && adapter.isEnabled() ? adapter.getBluetoothLeScanner() : null;
        if (scanner == null) {
            call.resolve(new JSObject()); // bucket omitted — Bluetooth off/unsupported, not an error
            return;
        }

        Set<String> seenAddresses = new HashSet<>();
        ScanCallback callback = new ScanCallback() {
            @Override
            public void onScanResult(int callbackType, ScanResult result) {
                seenAddresses.add(result.getDevice().getAddress());
            }

            @Override
            public void onBatchScanResults(List<ScanResult> results) {
                for (ScanResult result : results) seenAddresses.add(result.getDevice().getAddress());
            }
        };

        try {
            scanner.startScan(callback);
        } catch (SecurityException e) {
            call.reject("Nearby devices permission not granted");
            return;
        }

        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            try {
                scanner.stopScan(callback);
            } catch (SecurityException ignored) {
                // Permission may have been revoked mid-scan — nothing left to clean up.
            }
            JSObject result = new JSObject();
            result.put("bucket", bucketFor(seenAddresses.size()));
            call.resolve(result);
        }, SCAN_DURATION_MS);
    }

    private String alias() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? "scan" : "scanLegacy";
    }

    private static String bucketFor(int count) {
        if (count <= 0) return "0";
        if (count <= 2) return "1-2";
        if (count <= 5) return "3-5";
        return "6+";
    }
}
