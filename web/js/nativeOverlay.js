/**
 * Thin wrapper over the native Notify plugin's "Display over other apps" methods
 * (NotifyPlugin.java) -- the one permission the full-screen check-in (RiskOverlay.java) needs.
 * Granting it is the consent; there's no separate toggle. Only exists on Android.
 */
const NativeOverlay = (function () {
  function plugin() {
    return window.Capacitor?.Plugins?.Notify || null;
  }

  function available() {
    return !!(window.Capacitor?.isNativePlatform?.() && plugin());
  }

  async function hasPermission() {
    if (!available()) return false;
    const { granted } = await plugin().hasOverlayPermission();
    return granted;
  }

  // A Settings page, not a dialog: resolves once it's opened; PermissionsView re-checks on return.
  async function openPermissionSettings() {
    if (!available()) return;
    await plugin().openOverlaySettings();
  }

  return { available, hasPermission, openPermissionSettings };
})();
