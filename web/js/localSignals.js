/**
 * Thin wrapper over the native LocalSignals Capacitor plugin
 * (android/app/src/main/java/com/reclaim/app/LocalSignalsPlugin.java) — read-only access to
 * LocalSignalsDb, the native SQLite store the background collectors write to directly. See
 * PURPOSE.md for why this is a separate database from db.js's sql.js one.
 *
 * The one exception to "read-only" is the allowlist: the user manages it through the UI, so this
 * module is the source of truth for add/remove, same as it is for reads.
 */
const LocalSignals = (function () {
  function plugin() {
    return window.Capacitor?.Plugins?.LocalSignals || null;
  }

  function available() {
    return !!(window.Capacitor?.isNativePlatform?.() && plugin());
  }

  async function getUsageSamples(limit = 20) {
    if (!available()) return [];
    const { samples } = await plugin().getUsageSamples({ limit });
    return samples || [];
  }

  async function getAppEvents(limit = 20) {
    if (!available()) return [];
    const { events } = await plugin().getAppEvents({ limit });
    return events || [];
  }

  async function getKeywordMatches(limit = 20) {
    if (!available()) return [];
    const { matches } = await plugin().getKeywordMatches({ limit });
    return matches || [];
  }

  async function getAllowlist() {
    if (!available()) return [];
    const { apps } = await plugin().getAllowlist();
    return apps || [];
  }

  async function addAllowlistApp(packageName) {
    if (!available()) return;
    await plugin().addAllowlistApp({ packageName });
  }

  async function removeAllowlistApp(packageName) {
    if (!available()) return;
    await plugin().removeAllowlistApp({ packageName });
  }

  // Apps with a launcher entry, for the "add to allowlist" picker.
  async function getInstalledApps() {
    if (!available()) return [];
    const { apps } = await plugin().getInstalledApps();
    return apps || [];
  }

  // The other exception to "read-only": this data is entered/derived in the WebView
  // (db.js/UserPreferencesStore, CheckInStore), but RiskNudgeMonitor's scoring needs to read it
  // from a background Worker where the WebView isn't loaded — same reasoning as the allowlist
  // being native-owned. This just mirrors a copy into LocalSignalsDb's app_meta; db.js stays the
  // editable source of truth. See RiskProfile.syncToNative (riskProfile.js) for the caller.
  async function syncRiskContext(payload) {
    if (!available()) return;
    await plugin().syncRiskContext(payload);
  }

  // RiskNudgeMonitor writes the specific "here's what we noticed" detail here when it posts a
  // notification -- never in the notification itself, see that class's own comment for why.
  // Consumed once (native clears it on read), so call this only when actually about to show it.
  async function getPendingRiskAlert() {
    if (!available()) return null;
    const { alert } = await plugin().getPendingRiskAlert();
    return alert || null;
  }

  return {
    available,
    getUsageSamples,
    getAppEvents,
    getKeywordMatches,
    getAllowlist,
    addAllowlistApp,
    removeAllowlistApp,
    getInstalledApps,
    syncRiskContext,
    getPendingRiskAlert,
  };
})();
