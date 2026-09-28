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
 *     home_lat, home_lon,                            // number | null, captured via device GPS
 *   }
 *
 * home_lat/home_lon deliberately do NOT get mirrored into personalContext.js's AI-facing
 * sentences or into LocalSignalsDb (unlike everything else in this store) -- a raw coordinate
 * pair is meaningfully more sensitive than "tempted at night" or an accountability partner's
 * name, so it stays exactly where the user put it (this table, this device) and is used only for
 * the Home/Away label in Insights (insightsView.js), computed client-side against usage_samples'
 * own lat/lon. If a native risk-scoring use ever needs it, that's a deliberate future decision,
 * not something to wire up implicitly by extending the existing mirror.
 *
 * personalContext.js turns the rest of this into plain-language sentences for the AI's per-turn
 * context — this table is the single source of truth, not a separate file kept in sync by hand.
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
    home_lat: null,
    home_lon: null,
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
      next.home_lat ?? null,
      next.home_lon ?? null,
    ];
    if (exists) {
      DB.run(
        `UPDATE user_preferences SET
           accountability_name = ?, accountability_phone = ?,
           pastor_name = ?, pastor_phone = ?,
           tempting_times = ?, common_triggers = ?, tempting_locations = ?,
           notification_intensity = ?, other_notes = ?,
           onboarding_completed_at = ?, updated_at = ?,
           home_lat = ?, home_lon = ?
         WHERE id = 1`,
        params
      );
    } else {
      DB.run(
        `INSERT INTO user_preferences
           (id, accountability_name, accountability_phone, pastor_name, pastor_phone,
            tempting_times, common_triggers, tempting_locations,
            notification_intensity, other_notes, onboarding_completed_at, updated_at,
            home_lat, home_lon)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params
      );
    }
    DB.scheduleSave();
    // RiskNudgeMonitor (native, background) can't read db.js's sql.js DB, so the relevant fields
    // get mirrored into LocalSignalsDb's app_meta on every save -- see RiskProfile.syncToNative.
    // Fire-and-forget: a failure here just means the next notification won't have this context,
    // not a data-loss risk (db.js stays the real source of truth).
    if (typeof RiskProfile !== "undefined") RiskProfile.syncToNative();
    return next;
  }

  return { get, save };
})();
