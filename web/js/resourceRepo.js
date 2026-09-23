/**
 * Query layer over the resources table (see db.js). Everything here is
 * synchronous — sql.js runs entirely in-memory/WASM, so once DB.init() has
 * resolved these calls don't touch disk or the network. The one exception is
 * getSmallGroups(), which reads live from Supabase instead — see its own
 * comment for why.
 */
const US_STATES = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
  connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID",
  illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
  tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA",
  "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};

// Full names only, not 2-letter codes: "in", "or", "me", "hi", "ok", "la" etc. are also common
// English words, so a bare abbreviation would false-positive constantly in ordinary chat messages.
function detectState(text) {
  const lower = (text || "").toLowerCase();
  for (const [name, code] of Object.entries(US_STATES)) {
    if (new RegExp(`\\b${name}\\b`).test(lower)) return code;
  }
  return null;
}

const ResourceRepo = (function () {
  function parseRow(row) {
    if (!row) return null;
    return { ...row, tags: row.tags ? JSON.parse(row.tags) : [] };
  }

  function byType(type, limit) {
    const rows = DB.all(
      `SELECT * FROM resources WHERE type = ? ORDER BY id ${limit ? "LIMIT ?" : ""}`,
      limit ? [type, limit] : [type]
    );
    return rows.map(parseRow);
  }

  function randomByTheme(type, theme) {
    const rows = byType(type);
    if (theme) {
      const matches = rows.filter((r) => r.tags.includes(theme));
      if (matches.length) return matches[Math.floor(Math.random() * matches.length)];
    }
    return rows.length ? rows[Math.floor(Math.random() * rows.length)] : null;
  }

  function getScripture(theme) {
    return randomByTheme("scripture", theme);
  }

  function getSermons() {
    return byType("sermon");
  }

  function getArticles() {
    return byType("article");
  }

  function getDevotional(theme) {
    return randomByTheme("devotional", theme);
  }

  // Three at most: in the middle of an urge, a long list is more overwhelming than helpful.
  function getCopingMechanisms(theme, limit = 3) {
    const rows = shuffle(byType("coping_mechanism"));
    const matches = theme ? rows.filter((r) => r.tags.includes(theme)) : [];
    return [...matches, ...rows.filter((r) => !matches.includes(r))].slice(0, limit);
  }

  function shuffle(items) {
    const a = items.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function getBiblePlans() {
    const plans = byType("bible_plan");
    return plans.map((plan) => {
      const days = DB.all(
        "SELECT day_number, reference, reflection FROM bible_plan_days WHERE plan_id = ? ORDER BY day_number",
        [plan.id]
      );
      return { ...plan, days };
    });
  }

  // Reads live from Supabase, not local SQLite: real small groups are shared, publicly-sourced
  // content (not personal data), and this repo's local copy would go stale the moment a group's
  // schedule or contact changes. Deliberately no on-device fallback -- see README's "Data storage".
  //
  // Capped at 5 (matches the coping-toolkit precedent: a long list in the middle of a hard moment
  // overwhelms more than it helps) and filtered to a mentioned state when there is one, so "sort
  // through quickly" actually happens instead of returning all 36+ nationwide entries.
  //
  // Returns null on failure (network down, Supabase unreachable) so the caller can show a short
  // "couldn't reach the group directory" line instead of an empty or broken card.
  async function getSmallGroups(query, limit = 5) {
    const state = detectState(query);
    try {
      const rows = await SupabaseClient.queryResources("small_group", state ? { state } : {});
      if (state && !rows.length) return getSmallGroups(null, limit); // no match in that state -- fall back to a nationwide sample
      return shuffle(rows).slice(0, limit);
    } catch (e) {
      console.warn("Couldn't reach Supabase for small groups:", e);
      return null;
    }
  }

  function getAccountabilityPrograms() {
    return byType("accountability_program");
  }

  function getCounselingCenters() {
    return byType("counseling_center");
  }

  return {
    getScripture,
    getSermons,
    getArticles,
    getDevotional,
    getCopingMechanisms,
    getBiblePlans,
    getSmallGroups,
    getAccountabilityPrograms,
    getCounselingCenters,
  };
})();
