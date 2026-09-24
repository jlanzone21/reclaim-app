/**
 * Thin wrapper over the native Accessibility Capacitor plugin
 * (android/app/src/main/java/com/reclaim/app/AccessibilityPlugin.java) — ported from
 * reclaim-beta, already verified on-device there. Accessibility is a special access permission
 * like usage stats — no runtime dialog, granted manually via Settings. At this phase, the
 * underlying service is scoped to browser apps only and reads only the address bar, exposing
 * nothing here but a bare domain (e.g. "example.com") — never a full URL, page content, or any
 * other on-screen text. See PURPOSE.md for later phases that widen this.
 */
const NativeAccessibility = (function () {
  function plugin() {
    return window.Capacitor?.Plugins?.Accessibility || null;
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

  async function getDetectedDomain() {
    if (!available()) return null;
    const { domain } = await plugin().getDetectedDomain();
    return domain || null;
  }

  return { available, hasPermission, openPermissionSettings, getDetectedDomain };
})();
