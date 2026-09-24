/**
 * Thin wrapper over the native NotificationAccess Capacitor plugin
 * (android/app/src/main/java/com/reclaim/app/NotificationAccessPlugin.java) — ported from
 * reclaim-beta, already verified on-device there. Notification access is a special app-op
 * permission like usage stats — no runtime dialog, granted manually via Settings. Only ever
 * exposes the package name of whichever app most recently posted a notification, never its text.
 */
const NativeNotifications = (function () {
  function plugin() {
    return window.Capacitor?.Plugins?.NotificationAccess || null;
  }

  function available() {
    return !!(window.Capacitor?.isNativePlatform?.() && plugin());
  }

  async function hasPermission() {
    if (!available()) return false;
    const { granted } = await plugin().hasPermission();
    return granted;
  }

  async function openPermissionSettings() {
    if (!available()) return;
    await plugin().openPermissionSettings();
  }

  async function getRecentPackage() {
    if (!available()) return null;
    const { packageName } = await plugin().getRecentPackage();
    return packageName || null;
  }

  return { available, hasPermission, openPermissionSettings, getRecentPackage };
})();
