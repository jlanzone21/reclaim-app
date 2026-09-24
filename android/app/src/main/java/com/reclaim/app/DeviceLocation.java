package com.reclaim.app;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationManager;

import androidx.core.content.ContextCompat;

/**
 * Ported from reclaim-beta. Used by the periodic background sampler, which needs a location fix
 * without a JS bridge (nothing here can call back into the WebView). getLastKnownLocation() only
 * reads a passive/cached fix (no active GPS request) -- fast over fresh, on purpose.
 */
final class DeviceLocation {
    private DeviceLocation() {}

    static boolean hasAccess(Context ctx) {
        return ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
                || ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    // Fine access specifically.
    static boolean hasPreciseAccess(Context ctx) {
        return ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    // Raw fix, if any permission is granted -- rounded only at the call site, to whichever
    // resolution (coarse ~11km, or precise ~11cm) applies.
    static Location bestKnown(Context ctx) {
        if (!hasAccess(ctx)) return null;
        LocationManager lm = (LocationManager) ctx.getSystemService(Context.LOCATION_SERVICE);
        if (lm == null) return null;
        Location best = null;
        for (String provider : new String[]{LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER}) {
            try {
                Location loc = lm.getLastKnownLocation(provider);
                if (loc != null && (best == null || loc.getTime() > best.getTime())) best = loc;
            } catch (SecurityException | IllegalArgumentException ignored) {
                // Provider unavailable on this device, or a permission race -- skip it.
            }
        }
        return best;
    }

    static double roundTo(double value, int decimals) {
        double factor = Math.pow(10, decimals);
        return Math.round(value * factor) / factor;
    }
}
