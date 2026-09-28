/**
 * Self-reported check-ins, backed by the local SQLite database (db.js).
 * This is the raw data a future ML/pattern-recognition feature would train
 * on, so keep the shape stable:
 *
 *   {
 *     id, timestamp (ISO string), type: 'resisted' | 'slipped',
 *     tags: string[], notes,
 *     mood_rating: 1-5 | null,      // how they felt overall at check-in time
 *     urge_intensity: 1-5 | null,   // how strong the pull/urge was
 *     sleep_hours: number | null,   // no longer collected by the form (see checkinView.js --
 *                                   // condition tags already cover "what was going on" without a
 *                                   // second sleep-specific number); kept in the schema/shape so
 *                                   // any pre-existing logged values aren't silently dropped.
 *   }
 *
 * mood_rating/urge_intensity are optional (null when skipped) — self-reported
 * mood/urge are well-documented relapse-risk correlates, included so
 * a future model has more than just tags/notes to learn from, but the
 * check-in form must never feel like homework, so neither is
 * required.
 *
 * Everything stays on-device — nothing is sent anywhere. Callers must wait
 * for DB.init() to resolve (done once, at app startup) before using this.
 */
const CheckInStore = (function () {
  function parseRow(row) {
    return { ...row, tags: row.tags ? JSON.parse(row.tags) : [] };
  }

  function list() {
    const rows = DB.all("SELECT * FROM checkins ORDER BY timestamp DESC");
    return rows.map(parseRow);
  }

  function add(entry) {
    const record = {
      id: `checkin_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: entry.timestamp,
      type: entry.type,
      tags: entry.tags || [],
      notes: entry.notes || "",
      mood_rating: entry.mood_rating ?? null,
      urge_intensity: entry.urge_intensity ?? null,
      sleep_hours: entry.sleep_hours ?? null,
    };
    DB.run(
      `INSERT INTO checkins (id, timestamp, type, tags, notes, mood_rating, urge_intensity, sleep_hours)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.timestamp,
        record.type,
        JSON.stringify(record.tags),
        record.notes,
        record.mood_rating,
        record.urge_intensity,
        record.sleep_hours,
      ]
    );
    DB.scheduleSave();
    syncRiskProfile();
    recordOutcome(record);
    return record;
  }

  function remove(id) {
    DB.run("DELETE FROM checkins WHERE id = ?", [id]);
    DB.scheduleSave();
    syncRiskProfile();
  }

  function clear() {
    DB.run("DELETE FROM checkins");
    DB.scheduleSave();
    syncRiskProfile();
  }

  // A slip/resisted count or its tags/timing changing shifts RiskProfile's pattern (which
  // conditions/times have actually preceded past slips), so RiskNudgeMonitor's native mirror of
  // it needs to stay current after every check-in change, not just preference edits.
  function syncRiskProfile() {
    if (typeof RiskProfile !== "undefined") RiskProfile.syncToNative();
  }

  // RiskScorer's adaptive-tuning loop: only meaningful for a newly-added check-in (not a removal).
  // Tags feed the tag-correlation half (see RiskScorer's class doc comment) -- native no-ops
  // harmlessly for whichever half doesn't apply (no recent notification, no mapped tags, etc).
  function recordOutcome(record) {
    if (typeof LocalSignals === "undefined" || !LocalSignals.available()) return;
    LocalSignals.recordCheckinOutcome(record.type, Date.now(), record.tags).catch(() => {});
  }

  function exportJson() {
    return JSON.stringify(list(), null, 2);
  }

  return { list, add, remove, clear, exportJson };
})();
