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

  // `rank` (optional, everywhere below): a function that reorders candidate rows best-first. The
  // on-device AI agent passes one built from the person's thumbs up/down (resourcePicker.js); Basic
  // mode passes nothing and keeps the old random picks. Theme filtering still happens first here.
  function randomByTheme(type, theme, rank) {
    const rows = byType(type);
    let candidates = rows;
    if (theme) {
      const matches = rows.filter((r) => r.tags.includes(theme));
      if (matches.length) candidates = matches;
    }
    if (!candidates.length) return null;
    if (rank) return rank(candidates)[0];
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  // Rows that carry a theme tag, by type -- lets the picker tell whether a kind of resource has
  // anything to say about how someone feels before offering it unasked.
  function hasTheme(type, theme) {
    return DB.get("SELECT COUNT(*) AS n FROM resources WHERE type = ? AND tags LIKE ?", [type, `%"${theme}"%`]).n > 0;
  }

  function getScripture(theme, rank) {
    return randomByTheme("scripture", theme, rank);
  }

  // The 100 user-provided topics (see verse_topics table in db.js) -- matched against raw chat
  // text in agentTools.js's matchVerseTopic, not filtered/shuffled here since the caller needs
  // the full list to score against.
  function getVerseTopics() {
    return DB.all("SELECT topic, refs FROM verse_topics");
  }

  async function getSermons({ limit, rank } = {}) {
    return fromSupabase("sermon", { limit, rank });
  }

  async function getArticles({ limit, rank } = {}) {
    return fromSupabase("article", { limit, rank });
  }

  function getDevotional(theme, rank) {
    return randomByTheme("devotional", theme, rank);
  }

  // Two at most: in the middle of an urge, a long list is more overwhelming than helpful.
  // Ranked theme-and-preferred-method matches first, then theme-only, then preferred-method-only,
  // then whatever's left (already shuffled) -- preferred methods come from onboarding/preferences
  // (COPING_METHOD_OPTIONS in constants.js), read directly the same way getSmallGroups reads the
  // saved home location.
  function getCopingMechanisms(theme, limit = 2, rank) {
    const rows = shuffle(byType("coping_mechanism"));
    // The AI agent's ranker scores theme and preferred-method matches itself (alongside learned
    // preferences), so it gets the whole list.
    if (rank) return rank(rows).slice(0, limit);
    const prefs = typeof UserPreferencesStore !== "undefined" ? UserPreferencesStore.get() : null;
    const preferredMethods = (prefs && prefs.preferred_coping_methods) || [];
    const matchesTheme = theme ? rows.filter((r) => r.tags.includes(theme)) : [];
    const matchesMethod = preferredMethods.length ? rows.filter((r) => r.method && preferredMethods.includes(r.method)) : [];
    const ranked = [
      ...matchesTheme.filter((r) => matchesMethod.includes(r)),
      ...matchesTheme.filter((r) => !matchesMethod.includes(r)),
      ...matchesMethod.filter((r) => !matchesTheme.includes(r)),
    ];
    return [...ranked, ...rows.filter((r) => !ranked.includes(r))].slice(0, limit);
  }

  // Applies to any Supabase-backed resource with a gender column (small_group rows are the main
  // case today, plus a few gender-specific articles) -- a men's-only or women's-only group isn't a
  // usable suggestion for someone outside it, so this excludes the other gender's rows outright
  // rather than just deprioritizing them. Universal rows (gender is null -- Celebrate Recovery,
  // directory/find-a-group links, general articles) always stay. No filtering at all when the user
  // hasn't told us their gender (onboarding/preferences, optional, no default) -- better to show
  // everything than silently under-serve someone who hasn't answered.
  function filterByGender(rows) {
    const prefs = typeof UserPreferencesStore !== "undefined" ? UserPreferencesStore.get() : null;
    const gender = prefs && prefs.gender;
    if (!gender) return rows;
    return rows.filter((r) => !r.gender || r.gender === gender);
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
  function getBiblePlans(limit = 2, rank) {
    const plans = rank ? rank(byType("bible_plan")) : shuffle(byType("bible_plan"));
    return plans.slice(0, limit).map((plan) => {
      const days = DB.all(
        "SELECT day_number, reference, reflection FROM bible_plan_days WHERE plan_id = ? ORDER BY day_number",
        [plan.id]
      );
      return { ...plan, days };
    });
  }

  // Same Haversine formula as insightsView.js's own distanceMeters (not shared cross-file --
  // it's a one-off formula, not worth wiring a module for in this plain-script codebase).
  function distanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // Ranked by actual distance from the saved home location (onboarding/Privacy) when one is set
  // and at least some groups have coordinates -- closest first, real proximity instead of a
  // same-state coin flip. Falls back to the old text-detected-state match (then a nationwide
  // sample) when there's no saved home location, or none of the groups have coordinates yet.
  async function getSmallGroups(query, limit = 2, rank) {
    const home = typeof UserPreferencesStore !== "undefined" ? UserPreferencesStore.get() : null;
    if (home && home.home_lat != null && home.home_lon != null) {
      let rows;
      try {
        rows = await SupabaseClient.queryResources("small_group");
      } catch (e) {
        console.warn("Couldn't reach Supabase for small_group:", e);
        return null;
      }
      const withCoords = filterByGender(rows).filter((r) => r.latitude != null && r.longitude != null);
      if (withCoords.length) {
        const located = withCoords.map((r) => ({
          ...r,
          distanceMeters: distanceMeters(home.home_lat, home.home_lon, r.latitude, r.longitude),
        }));
        // The ranker weighs distance itself (a liked ministry 500 miles away isn't useful).
        if (rank) return rank(located).slice(0, limit);
        return located.sort((a, b) => a.distanceMeters - b.distanceMeters).slice(0, limit);
      }
    }

    const state = detectState(query);
    const rows = await fromSupabase("small_group", { state, limit, rank });
    if (rows === null) return null;
    if (state && !rows.length) return getSmallGroups(null, limit, rank); // no match in that state -- fall back to a nationwide sample
    return rows;
  }

  async function getCounselingCenters({ limit, rank } = {}) {
    return fromSupabase("counseling_center", { limit, rank });
  }

  // Shared by getSermons/getArticles/getCounselingCenters/getSmallGroups: capped at 2 and shuffled
  // (matches the coping-toolkit precedent -- a long list in the middle of a hard moment overwhelms
  // more than it helps) and returns null on failure (network down, Supabase unreachable) so the
  // caller can show a short "couldn't reach" line instead of an empty or broken card. Deliberately
  // no on-device fallback for any of these -- see README's "Data storage".
  async function fromSupabase(type, { state, limit = 2, rank } = {}) {
    try {
      const rows = filterByGender(await SupabaseClient.queryResources(type, state ? { state } : {}));
      return (rank ? rank(rows) : shuffle(rows)).slice(0, limit);
    } catch (e) {
      console.warn(`Couldn't reach Supabase for ${type}:`, e);
      return null;
    }
  }

  return {
    hasTheme,
    getScripture,
    getVerseTopics,
    getSermons,
    getArticles,
    getDevotional,
    getCopingMechanisms,
    getBiblePlans,
    getSmallGroups,
    getCounselingCenters,
  };
})();
