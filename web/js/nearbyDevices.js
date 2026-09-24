/**
 * Thin wrapper over the native NearbyDevices Capacitor plugin
 * (android/app/src/main/java/com/reclaim/app/NearbyDevicesPlugin.java) — ported from
 * reclaim-beta, already verified on-device there. Unlike usage stats/notifications/accessibility,
 * this is a normal runtime permission (BLUETOOTH_SCAN on Android 12+, ACCESS_FINE_LOCATION below
 * — the plugin picks whichever applies), so it follows a request/response shape rather than a
 * settings deep-link. getBucket() runs a short scan natively and only ever returns a count bucket
 * ("0" / "1-2" / "3-5" / "6+") — never a device address or name.
 */
const NearbyDevices = (function () {
  function plugin() {
    return window.Capacitor?.Plugins?.NearbyDevices || null;
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

  async function getBucket() {
    if (!(await hasPermission())) return null;
    try {
      const { bucket } = await plugin().getNearbyDeviceBucket();
      return bucket || null;
    } catch (e) {
      return null;
    }
  }

  return { available, hasPermission, requestPermission, getBucket };
})();
