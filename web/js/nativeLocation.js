/**
 * Wraps Capacitor's official @capacitor/geolocation plugin plus the native LocationAlways
 * Capacitor plugin (android/app/src/main/java/com/reclaim/app/LocationAlwaysPlugin.java) for
 * background access. Ported from reclaim-beta, already verified on-device there.
 *
 * Always computes a coarse pair rounded to 1 decimal degree (~11 km) — coarse enough to be
 * useless for finding someone's address, but still enough to notice broad patterns (home area vs.
 * away). Also captures a precise pair (6 decimals, ~11 cm) whenever the OS granted fine/"Precise"
 * access — Android's own Precise/Approximate permission dialog is what makes that choice, since
 * both ACCESS_COARSE_LOCATION and ACCESS_FINE_LOCATION are requested together (see
 * AndroidManifest.xml); this module just honors whichever the user picked.
 */
const NativeLocation = (function () {
  function plugin() {
    return window.Capacitor?.Plugins?.Geolocation || null;
  }

  function available() {
    return !!(window.Capacitor?.isNativePlatform?.() && plugin());
  }

  async function hasPermission() {
    if (!available()) return false;
    const status = await plugin().checkPermissions();
    return status.location === "granted" || status.coarseLocation === "granted";
  }

  // True only when fine ("Precise") access was granted, not just coarse.
  async function hasPrecisePermission() {
    if (!available()) return false;
    const status = await plugin().checkPermissions();
    return status.location === "granted";
  }

  async function requestPermission() {
    if (!available()) return false;
    const status = await plugin().requestPermissions();
    return status.location === "granted" || status.coarseLocation === "granted";
  }

  // "Allow all the time" — a separate OS permission (ACCESS_BACKGROUND_LOCATION) the official
  // Geolocation plugin doesn't cover at all, so this delegates to our own LocationAlwaysPlugin.java.
  // Only actionable once foreground access is already granted; see permissionsView.js's
  // furtherGrant step.
  function alwaysPlugin() {
    return window.Capacitor?.Plugins?.LocationAlways || null;
  }

  async function hasAlwaysPermission() {
    if (!available() || !alwaysPlugin()) return false;
    const { granted } = await alwaysPlugin().hasPermission();
    return granted;
  }

  async function requestAlwaysPermission() {
    if (!available() || !alwaysPlugin()) return false;
    const { granted } = await alwaysPlugin().requestPermission();
    return granted;
  }

  const roundTo = (n, decimals) => {
    const factor = 10 ** decimals;
    return Math.round(n * factor) / factor;
  };

  async function getPosition() {
    if (!(await hasPermission())) return null;
    const precise = await hasPrecisePermission();
    try {
      const pos = await plugin().getCurrentPosition({ enableHighAccuracy: precise, timeout: 8000 });
      const { latitude, longitude } = pos.coords;
      return {
        coarse_lat: roundTo(latitude, 1),
        coarse_lon: roundTo(longitude, 1),
        precise_lat: precise ? roundTo(latitude, 6) : null,
        precise_lon: precise ? roundTo(longitude, 6) : null,
      };
    } catch (e) {
      return null;
    }
  }

  return {
    available,
    hasPermission,
    hasPrecisePermission,
    requestPermission,
    hasAlwaysPermission,
    requestAlwaysPermission,
    getPosition,
  };
})();
