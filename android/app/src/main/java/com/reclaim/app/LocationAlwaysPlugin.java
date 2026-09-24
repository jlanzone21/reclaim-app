package com.reclaim.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Ported from reclaim-beta (verified on-device there). The official @capacitor/geolocation plugin
 * only covers foreground access -- no concept of ACCESS_BACKGROUND_LOCATION at all, so "Allow all
 * the time" needs its own plugin. Android requires foreground location to already be granted
 * before background can be requested; the UI only offers this once foreground access is already
 * true (see permissionsView-equivalent's furtherGrant mechanism).
 *
 * Below API 30, requesting ACCESS_BACKGROUND_LOCATION shows a normal system dialog with an "Allow
 * all the time" option. Starting API 30, Android removed that dialog option entirely -- the only
 * way to grant it is the user manually picking "Allow all the time" on the app's own permission
 * page, so openPermissionSettings() is the only path there, same "special access, deep-link to
 * Settings" pattern as UsageStatsPlugin.
 */
@CapacitorPlugin(
    name = "LocationAlways",
    permissions = { @Permission(strings = { Manifest.permission.ACCESS_BACKGROUND_LOCATION }, alias = "always") }
)
public class LocationAlwaysPlugin extends Plugin {

    @PluginMethod
    public void hasPermission(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", getPermissionState("always") == PermissionState.GRANTED);
        call.resolve(result);
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (getPermissionState("always") == PermissionState.GRANTED) {
            JSObject result = new JSObject();
            result.put("granted", true);
            call.resolve(result);
            return;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            requestPermissionForAlias("always", call, "permissionCallback");
        } else {
            openPermissionSettings(call);
        }
    }

    @PermissionCallback
    private void permissionCallback(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", getPermissionState("always") == PermissionState.GRANTED);
        call.resolve(result);
    }

    @PluginMethod
    public void openPermissionSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        intent.setData(Uri.fromParts("package", getContext().getPackageName(), null));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }
}
