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

  // NightlyCheckinActionReceiver writes this when a notification action is actually tapped --
  // "quick_resisted" or "open_checkin". Consumed once, same reasoning as getPendingRiskAlert.
  async function getPendingNightlyAction() {
    if (!available()) return null;
    const { action } = await plugin().getPendingNightlyAction();
    return action || null;
  }

  // MainActivity writes this when the notification's "Read a verse" action specifically (not a
  // body tap) is what opened the app. Consumed once, same reasoning as getPendingNightlyAction --
  // check this BEFORE getPendingRiskAlert on boot/resume, since MainActivity already cleared the
  // risk alert itself for this case, so the auto-submitted scripture request should win, not a
  // detail popup that's no longer pending anyway.
  async function getPendingVerseRequest() {
    if (!available()) return false;
    const { pending, kind } = await plugin().getPendingVerseRequest();
    return pending ? kind || "verse" : false;
  }

  // RiskScorer's adaptive-tuning loop, both halves: correlates this check-in against whichever
  // risk-nudge notification most recently fired (if any, and if recent enough), AND against this
  // check-in's own tags (independent of any notification) -- see RiskScorer.java's class doc
  // comment. A no-op on native's side for whichever half doesn't apply -- safe to call after
  // every check-in.
  async function recordCheckinOutcome(type, timestampMs, tags) {
    if (!available()) return;
    await plugin().recordCheckinOutcome({ type, timestamp: timestampMs, tags: tags || [] });
  }

  // Factors the AI judged a piece of the person's own writing to be about (RiskExplainer.learnFromWords).
  async function nudgeWeights(factors, increase) {
    if (!available()) return;
    await plugin().nudgeWeights({ factors: factors || [], increase: increase !== false });
  }

  // The person's verdict on a risk alert (see RiskExplainer): nudges the weights of the factors
  // that fired, once per alert. Resolves {adjusted: string[], duplicate: boolean} -- adjusted is
  // the factors that are actually tunable, so the UI can say truthfully what changed.
  async function recordRiskFeedback({ alertId, valid, factors }) {
    if (!available()) return null;
    return plugin().recordRiskFeedback({ alertId, valid, factors: factors || [] });
  }

  // MainActivity writes this when the overlay's "Pray through <passage>" button or the fallback
  // notification is what opened the app: {ref, description, sig, bucket, alertId}, so the app opens
  // straight into the Lectio Divina meditation on that passage (app.js). Consumed once. Check it
  // BEFORE getPendingRiskAlert -- the meditation takes that alert for its false-alarm link.
  async function getPendingMeditation() {
    if (!available()) return null;
    const { meditation } = await plugin().getPendingMeditation();
    return meditation && meditation.ref ? meditation : null;
  }

  // Words the person typed on the full-screen check-in's flag page (native can't run the model, so
  // they wait here for RiskExplainer.processFeedbackNotes). Each: {alertId, app, text, factors,
  // applied, at}. Consumed once.
  async function takePendingFeedbackNotes() {
    if (!available()) return [];
    const { notes } = await plugin().getPendingFeedbackNotes();
    return notes || [];
  }

  // How many nightly/risk notifications have been sent vs. actually responded to (any action tap
  // or opening the app counts -- see NotificationTracking.java). Shape:
  // {"nightly":{"sent":N,"responded":N},"risk":{"sent":N,"responded":N}}, either key possibly
  // missing if that type has never posted yet.
  async function getNotificationStats() {
    if (!available()) return {};
    const { stats } = await plugin().getNotificationStats();
    return stats || {};
  }

  // ============================================================================================
  // TEMPORARY -- backs the Testing panel (debugTestPanel.js). See LocalSignalsPlugin.java's own
  // matching comment block; remove both together before shipping this to a real user.
  // ============================================================================================

  async function debugRunBackgroundCheck() {
    if (!available()) return;
    await plugin().debugRunBackgroundCheck();
  }

  async function debugSendNightlyCheckin() {
    if (!available()) return;
    await plugin().debugSendNightlyCheckin();
  }

  // packageName/minutes (optional): score "N minutes on <that app>" instead of the real foreground
  // session -- lets a test fire a nudge for another app while this one is backgrounded.
  async function debugSendRiskNudge(packageName, minutes) {
    if (!available()) return;
    await plugin().debugSendRiskNudge({ packageName: packageName || "", minutes: minutes || 0 });
  }

  async function debugClearRiskNudgeCooldown() {
    if (!available()) return;
    await plugin().debugClearRiskNudgeCooldown();
  }

  async function debugPeekPendingRiskAlert() {
    if (!available()) return null;
    const { raw } = await plugin().debugPeekPendingRiskAlert();
    return raw || null;
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
    getPendingNightlyAction,
    getPendingVerseRequest,
    getPendingMeditation,
    recordCheckinOutcome,
    nudgeWeights,
    recordRiskFeedback,
    takePendingFeedbackNotes,
    getNotificationStats,
    debugRunBackgroundCheck,
    debugSendNightlyCheckin,
    debugSendRiskNudge,
    debugClearRiskNudgeCooldown,
    debugPeekPendingRiskAlert,
  };
})();
