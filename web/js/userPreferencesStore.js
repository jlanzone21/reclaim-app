/**
 * One person's own setup answers, backed by the local SQLite database (db.js) — a singleton row
 * (id always 1), not a log like checkins. Collected during onboarding, editable any time from
 * Privacy. Everything stays on-device.
 *
 *   {
 *     accountability_name, accountability_phone,     // optional; a place to fill in later matters
 *     accountability_name_2, accountability_phone_2, // up to 2 partners -- both optional
 *     pastor_name, pastor_phone,                    // as much as the initial prompt
 *     tempting_times: string[],                     // subset of TEMPTING_TIME_BUCKETS
 *     common_triggers: string[],                    // subset of CONDITION_TAGS (constants.js)
 *     tempting_locations,                            // free text
 *     notification_intensity: 'low' | 'medium' | 'high',
 *     lock_screen_detail: boolean,                   // default true: notification text says WHY ("You've been on
 *                                                    // Instagram for 22 minutes"); false = generic wording
 *     other_notes,
 *     onboarding_completed_at,                       // ISO string once they've been through setup
 *     home_lat, home_lon,                            // number | null, captured via device GPS
 *     gender: 'male' | 'female' | null,              // optional, no default
 *     preferred_coping_methods: string[],             // subset of COPING_METHOD_OPTIONS (constants.js)
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
    accountability_name_2: "",
    accountability_phone_2: "",
    pastor_name: "",
    pastor_phone: "",
    tempting_times: [],
    common_triggers: [],
    tempting_locations: "",
    notification_intensity: "medium",
    lock_screen_detail: true,
    other_notes: "",
    onboarding_completed_at: null,
    home_lat: null,
    home_lon: null,
    gender: null,
    preferred_coping_methods: [],
  };

  function parseRow(row) {
    if (!row) return { ...DEFAULTS };
    return {
      ...DEFAULTS,
      ...row,
      tempting_times: row.tempting_times ? JSON.parse(row.tempting_times) : [],
      common_triggers: row.common_triggers ? JSON.parse(row.common_triggers) : [],
      preferred_coping_methods: row.preferred_coping_methods ? JSON.parse(row.preferred_coping_methods) : [],
      // Stored as 0/1; a row from before this column existed reads NULL, which means the default (on).
      lock_screen_detail: row.lock_screen_detail === 0 ? false : true,
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
      next.accountability_name_2 || null,
      next.accountability_phone_2 || null,
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
      next.gender || null,
      JSON.stringify(next.preferred_coping_methods || []),
      next.lock_screen_detail === false ? 0 : 1,
    ];
    if (exists) {
      DB.run(
        `UPDATE user_preferences SET
           accountability_name = ?, accountability_phone = ?,
           accountability_name_2 = ?, accountability_phone_2 = ?,
           pastor_name = ?, pastor_phone = ?,
           tempting_times = ?, common_triggers = ?, tempting_locations = ?,
           notification_intensity = ?, other_notes = ?,
           onboarding_completed_at = ?, updated_at = ?,
           home_lat = ?, home_lon = ?, gender = ?, preferred_coping_methods = ?,
           lock_screen_detail = ?
         WHERE id = 1`,
        params
      );
    } else {
      DB.run(
        `INSERT INTO user_preferences
           (id, accountability_name, accountability_phone, accountability_name_2, accountability_phone_2,
            pastor_name, pastor_phone,
            tempting_times, common_triggers, tempting_locations,
            notification_intensity, other_notes, onboarding_completed_at, updated_at,
            home_lat, home_lon, gender, preferred_coping_methods, lock_screen_detail)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
