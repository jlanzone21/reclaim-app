/**
 * Thin wrapper over the native BackgroundSampler Capacitor plugin
 * (android/.../BackgroundSamplerPlugin.java), which schedules BaselineSampleWorker to run
 * roughly every 15 minutes via WorkManager — independent of the WebView, so it keeps running even
 * while the app is closed. This module only ever starts that schedule; the actual sampling and
 * the write to LocalSignalsDb happen entirely natively (see that file), so there is nothing else
 * for this module, or any JS, to do afterward.
 *
 * Simpler than reclaim-beta's equivalent: no device id to configure, since nothing collected here
 * is ever sent anywhere — there's no remote row to attribute to a device.
 */
const BackgroundSampler = (function () {
  function plugin() {
    return window.Capacitor?.Plugins?.BackgroundSampler || null;
  }

  function available() {
    return !!(window.Capacitor?.isNativePlatform?.() && plugin());
  }

  async function enable() {
    if (!available()) return;
    await plugin().enable();
  }

  return { available, enable };
})();
