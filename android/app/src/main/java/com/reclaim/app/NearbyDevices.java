package com.reclaim.app;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanResult;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.content.ContextCompat;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Plain native helper (no Capacitor bridge) for BaselineSampleWorker, which runs off the main
 * thread with no WebView/JS available -- same reasoning as DeviceLocation.java. Mirrors
 * NearbyDevicesPlugin's scan-and-bucket logic (that plugin stays JS-facing, for the Privacy tab's
 * permission-grant UI only) but blocks the calling thread for the scan window instead of using a
 * Handler callback, since a Worker's doWork() is expected to do blocking work off the main thread
 * -- unlike a Capacitor plugin method, which must never block like this.
 */
final class NearbyDevices {
    private NearbyDevices() {}

    private static final long SCAN_DURATION_MS = 3000;

    static boolean hasAccess(Context ctx) {
        String perm = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                ? Manifest.permission.BLUETOOTH_SCAN
                : Manifest.permission.ACCESS_FINE_LOCATION;
        return ContextCompat.checkSelfPermission(ctx, perm) == PackageManager.PERMISSION_GRANTED;
    }

    // Bucketed count of distinct BLE devices seen in one ~3-second scan window (0 / 1-2 / 3-5 /
    // 6+) -- same privacy shape as NearbyDevicesPlugin's JS-facing version: a device's address is
    // only ever used in-memory, for this one moment, to dedupe the count, never stored or
    // transmitted. Returns null if there's no access, no adapter, or Bluetooth is off -- "unknown,"
    // not "zero," so RiskScorer's alone factor never fires on missing data.
    static String bucket(Context ctx) {
        if (!hasAccess(ctx)) return null;
        BluetoothManager btManager = (BluetoothManager) ctx.getSystemService(Context.BLUETOOTH_SERVICE);
        BluetoothAdapter adapter = btManager != null ? btManager.getAdapter() : null;
        if (adapter == null || !adapter.isEnabled()) return null;
        BluetoothLeScanner scanner = adapter.getBluetoothLeScanner();
        if (scanner == null) return null;

        Set<String> seenAddresses = new HashSet<>();
        ScanCallback callback = new ScanCallback() {
            @Override
            public void onScanResult(int callbackType, ScanResult result) {
                if (result.getDevice() != null) seenAddresses.add(result.getDevice().getAddress());
            }

            @Override
            public void onBatchScanResults(List<ScanResult> results) {
                for (ScanResult result : results) {
                    if (result.getDevice() != null) seenAddresses.add(result.getDevice().getAddress());
                }
            }
        };

        try {
            scanner.startScan(callback);
            Thread.sleep(SCAN_DURATION_MS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return null;
        } catch (SecurityException e) {
            return null; // permission revoked between the check above and the scan call
        } finally {
            try {
                scanner.stopScan(callback);
            } catch (SecurityException ignored) {
                // Permission may have been revoked mid-scan -- nothing left to clean up.
            }
        }
        return bucketFor(seenAddresses.size());
    }

    private static String bucketFor(int count) {
        if (count <= 0) return "0";
        if (count <= 2) return "1-2";
        if (count <= 5) return "3-5";
        return "6+";
    }
}
