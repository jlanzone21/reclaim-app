/**
 * One person's own setup answers, backed by the local SQLite database (db.js) — a singleton row
 * (id always 1), not a log like checkins. Collected during onboarding, editable any time from
 * Privacy. Everything stays on-device.
 *
 *   {
 *     accountability_name, accountability_phone,   // optional; a place to fill in later matters
 *     pastor_name, pastor_phone,                    // as much as the initial prompt
 *     tempting_times: string[],                     // subset of TEMPTING_TIME_BUCKETS
 *     common_triggers: string[],                    // subset of CONDITION_TAGS (constants.js)
 *     tempting_locations,                            // free text
 *     notification_intensity: 'low' | 'medium' | 'high',
 *     other_notes,
 *     onboarding_completed_at,                       // ISO string once they've been through setup
 *   }
 *
 * personalContext.js turns this into plain-language sentences for the AI's per-turn context —
 * this table is the single source of truth, not a separate file kept in sync by hand.
 */
const UserPreferencesStore = (function () {
  const DEFAULTS = {
    accountability_name: "",
    accountability_phone: "",
    pastor_name: "",
    pastor_phone: "",
    tempting_times: [],
    common_triggers: [],
    tempting_locations: "",
    notification_intensity: "medium",
    other_notes: "",
    onboarding_completed_at: null,
  };

  function parseRow(row) {
    if (!row) return { ...DEFAULTS };
    return {
      ...DEFAULTS,
      ...row,
      tempting_times: row.tempting_times ? JSON.parse(row.tempting_times) : [],
      common_triggers: row.common_triggers ? JSON.parse(row.common_triggers) : [],
    };
  }

  function get() {
    return parseRow(DB.get("SELECT * FROM user_preferences WHERE id = 1"));
  }

  function save(fields) {
    const current = get();
    const next = { ...current, ...fields };
    const exists = DB.get("SELECT id FROM user_preferences WHERE id = 1");
    const now = new Date().toISOString();
    const params = [
      next.accountability_name || null,
      next.accountability_phone || null,
      next.pastor_name || null,
      next.pastor_phone || null,
      JSON.stringify(next.tempting_times || []),
      JSON.stringify(next.common_triggers || []),
      next.tempting_locations || null,
      next.notification_intensity || "medium",
      next.other_notes || null,
      next.onboarding_completed_at || null,
      now,
    ];
    if (exists) {
      DB.run(
        `UPDATE user_preferences SET
           accountability_name = ?, accountability_phone = ?,
           pastor_name = ?, pastor_phone = ?,
           tempting_times = ?, common_triggers = ?, tempting_locations = ?,
           notification_intensity = ?, other_notes = ?,
           onboarding_completed_at = ?, updated_at = ?
         WHERE id = 1`,
        params
      );
    } else {
      DB.run(
        `INSERT INTO user_preferences
           (id, accountability_name, accountability_phone, pastor_name, pastor_phone,
            tempting_times, common_triggers, tempting_locations,
            notification_intensity, other_notes, onboarding_completed_at, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params
      );
    }
    DB.scheduleSave();
    syncAccountabilityContactToNative(next);
    return next;
  }

  // RiskNudgeMonitor (native, background) can't read db.js's sql.js DB, so the accountability
  // contact gets mirrored into LocalSignalsDb's app_meta on every save. Fire-and-forget: a failure
  // here just means the next notification won't have a call button, not a data-loss risk (db.js
  // stays the real source of truth).
  function syncAccountabilityContactToNative(prefs) {
    if (typeof LocalSignals === "undefined" || !LocalSignals.available()) return;
    LocalSignals.setAccountabilityContact(prefs.accountability_name, prefs.accountability_phone).catch(() => {});
  }

  return { get, save, syncAccountabilityContactToNative };
})();
