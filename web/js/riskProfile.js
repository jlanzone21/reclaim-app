/**
 * Turns check-in history into a structured risk profile -- which conditions and times of day
 * have actually preceded this person's own past slips, not just what they said in onboarding.
 * Same tag-frequency reasoning personalContext.js already uses for chat (buildPersonalContext),
 * applied here to drive RiskNudgeMonitor's scoring instead of a prose sentence.
 *
 * This, plus the relevant bits of UserPreferencesStore, gets mirrored into LocalSignalsDb's
 * app_meta (see syncToNative below) so the native background Worker that actually does the
 * scoring can read it without the WebView being loaded -- same reasoning as the accountability
 * contact mirror.
 */
const RiskProfile = (function () {
  // Same four buckets as TEMPTING_TIME_BUCKETS (constants.js) and insightsView.js's time-of-day
  // chart -- kept in sync by hand, must match or "risky time" would silently mean different things.
  const TIME_BUCKET_DEFS = [
    ["Morning", (h) => h >= 5 && h < 12],
    ["Afternoon", (h) => h >= 12 && h < 17],
    ["Evening", (h) => h >= 17 && h < 22],
    ["Night", (h) => h >= 22 || h < 5],
  ];

  function bucketFor(hour) {
    const found = TIME_BUCKET_DEFS.find(([, test]) => test(hour));
    return found ? found[0] : null;
  }

  // Only ever looks at slipped check-ins -- a resisted check-in isn't risk signal, it's the
  // opposite. Needs at least 2 slips before claiming a pattern; one data point isn't a pattern.
  function build(checkins) {
    const slips = (checkins || []).filter((c) => c.type === "slipped");
    if (slips.length < 2) return { topTags: [], riskyTimeBuckets: [] };

    const tagCounts = {};
    for (const c of slips) for (const t of c.tags || []) if (t !== "Other") tagCounts[t] = (tagCounts[t] || 0) + 1;
    const topTags = Object.entries(tagCounts)
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([t]) => t);

    const bucketCounts = {};
    for (const c of slips) {
      const b = bucketFor(new Date(c.timestamp).getHours());
      if (b) bucketCounts[b] = (bucketCounts[b] || 0) + 1;
    }
    // A bucket only counts as "risky" if it accounts for a real share of slips, not just
    // whichever bucket happened to have one more than the others.
    const riskyTimeBuckets = Object.entries(bucketCounts)
      .filter(([, n]) => n / slips.length >= 0.3)
      .sort((a, b) => b[1] - a[1])
      .map(([b]) => b);

    return { topTags, riskyTimeBuckets };
  }

  // Fire-and-forget, called after anything that changes the inputs (a new check-in, a saved
  // preference) and once at boot to cover data that already existed before this exists.
  function syncToNative() {
    const native = typeof LocalSignals !== "undefined" && LocalSignals.available();
    const extension = typeof WebTracker !== "undefined" && WebTracker.available();
    if (!native && !extension) return;
    if (typeof UserPreferencesStore === "undefined" || typeof CheckInStore === "undefined") return;
    const prefs = UserPreferencesStore.get();
    const profile = build(CheckInStore.list());
    // Same payload for both: on Android it's mirrored into LocalSignalsDb for the background
    // Worker; in a browser it goes to the extension's local storage for its background scorer.
    const payload = {
      accountabilityName: prefs.accountability_name || "",
      accountabilityPhone: prefs.accountability_phone || "",
      accountabilityName2: prefs.accountability_name_2 || "",
      accountabilityPhone2: prefs.accountability_phone_2 || "",
      temptingTimes: prefs.tempting_times || [],
      commonTriggers: prefs.common_triggers || [],
      intensity: prefs.notification_intensity || "medium",
      topSlipTags: profile.topTags,
      riskyTimeBuckets: profile.riskyTimeBuckets,
      // Notification wording: whether the lock screen may show the specific reason (default ON),
      // and the phrase templates the on-device AI wrote -- see RiskExplainer / RiskNotificationText.
      lockScreenDetail: prefs.lock_screen_detail !== false,
      phraseBank: typeof RiskExplainer !== "undefined" ? RiskExplainer.getPhraseBank() : {},
      noteBank: typeof RiskExplainer !== "undefined" ? RiskExplainer.getNoteBank() : {},
      // The Bible verse shown on the full-screen check-in, chosen ahead of time by the on-device AI.
      verseBank: typeof VerseBank !== "undefined" ? VerseBank.getBank() : {},
    };
    if (native) LocalSignals.syncRiskContext(payload).catch(() => {});
    if (extension) WebTracker.syncRiskContext(payload);
  }

  return { build, bucketFor, syncToNative };
})();
