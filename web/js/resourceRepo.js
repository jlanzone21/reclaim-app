/**
 * Query layer over the resources table (see db.js). Scripture, devotionals, coping techniques,
 * and Bible plans are the app's own written content, so those stay synchronous against the local
 * sql.js copy. Small groups, sermons, articles, and counseling centers are all shared, publicly-
 * sourced directory content instead — real orgs/people with real contacts that go stale the
 * moment a link or number changes — so those four all read live from Supabase, never a local
 * copy. See getSmallGroups' own comment for the fuller reasoning; the other three follow it
 * exactly via fromSupabase() below.
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

  async function getSermons() {
    return fromSupabase("sermon");
  }

  async function getArticles() {
    return fromSupabase("article");
  }

  function getDevotional(theme) {
    return randomByTheme("devotional", theme);
  }

  // Two at most: in the middle of an urge, a long list is more overwhelming than helpful.
  function getCopingMechanisms(theme, limit = 2) {
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

  // Two at most, same reasoning as everything else here -- there are only 4 today, but this
  // shouldn't silently start dumping all of them the moment a 5th gets added.
  function getBiblePlans(limit = 2) {
    const plans = shuffle(byType("bible_plan"));
    return plans.slice(0, limit).map((plan) => {
      const days = DB.all(
        "SELECT day_number, reference, reflection FROM bible_plan_days WHERE plan_id = ? ORDER BY day_number",
        [plan.id]
      );
      return { ...plan, days };
    });
  }

  // Filtered to a mentioned state when there is one, so "sort through quickly" actually happens
  // instead of returning all 36+ nationwide entries. See getSmallGroups' comment for why this
  // reads live rather than from a local copy.
  async function getSmallGroups(query, limit = 2) {
    const state = detectState(query);
    const rows = await fromSupabase("small_group", { state, limit });
    if (rows === null) return null;
    if (state && !rows.length) return getSmallGroups(null, limit); // no match in that state -- fall back to a nationwide sample
    return rows;
  }

  async function getCounselingCenters() {
    return fromSupabase("counseling_center");
  }

  // Shared by getSermons/getArticles/getCounselingCenters/getSmallGroups: capped at 2 and shuffled
  // (matches the coping-toolkit precedent -- a long list in the middle of a hard moment overwhelms
  // more than it helps) and returns null on failure (network down, Supabase unreachable) so the
  // caller can show a short "couldn't reach" line instead of an empty or broken card. Deliberately
  // no on-device fallback for any of these -- see README's "Data storage".
  async function fromSupabase(type, { state, limit = 2 } = {}) {
    try {
      const rows = await SupabaseClient.queryResources(type, state ? { state } : {});
      return shuffle(rows).slice(0, limit);
    } catch (e) {
      console.warn(`Couldn't reach Supabase for ${type}:`, e);
      return null;
    }
  }

  return {
    getScripture,
    getSermons,
    getArticles,
    getDevotional,
    getCopingMechanisms,
    getBiblePlans,
    getSmallGroups,
    getCounselingCenters,
  };
})();
