package com.reclaim.app;

import android.Manifest;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Ported from reclaim-beta. POST_NOTIFICATIONS -- a plain runtime permission with a normal system
 * dialog, unlike the "special access" Settings-page permissions elsewhere in this app (usage
 * stats, notification access, accessibility). Only meaningful on API 33+; Android treats it as
 * always-granted below that, so getPermissionState()/checkSelfPermission just report GRANTED
 * there with no dialog needed.
 *
 * Backs the verification feature in ForegroundAppMonitor.java, which posts a local notification
 * asking whether a detected 1-hour app session actually matches reality.
 */
@CapacitorPlugin(
    name = "Notify",
    permissions = { @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "post") }
)
public class NotifyPlugin extends Plugin {

    @PluginMethod
    public void hasPermission(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", getPermissionState("post") == PermissionState.GRANTED);
        call.resolve(result);
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (getPermissionState("post") == PermissionState.GRANTED || Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            JSObject result = new JSObject();
            result.put("granted", true);
            call.resolve(result);
            return;
        }
        requestPermissionForAlias("post", call, "permissionCallback");
    }

    @PermissionCallback
    private void permissionCallback(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", getPermissionState("post") == PermissionState.GRANTED);
        call.resolve(result);
    }
}
