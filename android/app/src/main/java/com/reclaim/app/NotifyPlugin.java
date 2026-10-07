package com.reclaim.app;

import android.Manifest;
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

    // "Display over other apps" (SYSTEM_ALERT_WINDOW) -- a special-access Settings-page permission,
    // not a runtime dialog. Backs the full-screen check-in (RiskOverlay); granting it is the
    // consent, with no separate toggle.
    @PluginMethod
    public void hasOverlayPermission(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", RiskOverlay.canShow(getContext()));
        call.resolve(result);
    }

    @PluginMethod
    public void openOverlaySettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getContext().getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    @PermissionCallback
    private void permissionCallback(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", getPermissionState("post") == PermissionState.GRANTED);
        call.resolve(result);
    }
}
