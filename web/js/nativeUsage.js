/**
 * Thin wrapper over the native UsageStats Capacitor plugin
 * (android/app/src/main/java/com/reclaim/app/UsageStatsPlugin.java) —
 * ported from reclaim-beta, already verified on-device there.
 *
 * Only exists on Android — Capacitor auto-injects window.Capacitor and its
 * registered plugins into the WebView at runtime, so there's nothing to
 * bundle here. On desktop or in a plain browser, available() returns false
 * and every other call resolves to an empty/false result.
 */
const NativeUsage = (function () {
  function plugin() {
    return window.Capacitor?.Plugins?.UsageStats || null;
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

  async function getUsageStats(startTime, endTime) {
    if (!available()) return [];
    const { stats } = await plugin().getUsageStats({ startTime, endTime });
    return stats;
  }

  return { available, hasPermission, openPermissionSettings, getUsageStats };
})();
