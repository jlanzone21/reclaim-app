/**
 * Thin wrapper over the native Notify Capacitor plugin
 * (android/app/src/main/java/com/reclaim/app/NotifyPlugin.java) — the plain POST_NOTIFICATIONS
 * runtime permission, ported from reclaim-beta. Backs ForegroundAppMonitor.java's verification
 * feature (see its comment).
 *
 * Only exists on Android — see nativeUsage.js's header for why.
 */
const NativeNotify = (function () {
  function plugin() {
    return window.Capacitor?.Plugins?.Notify || null;
  }

  function available() {
    return !!(window.Capacitor?.isNativePlatform?.() && plugin());
  }

  async function hasPermission() {
    if (!available()) return false;
    const { granted } = await plugin().hasPermission();
    return granted;
  }

  async function requestPermission() {
    if (!available()) return false;
    const { granted } = await plugin().requestPermission();
    return granted;
  }

  return { available, hasPermission, requestPermission };
})();
