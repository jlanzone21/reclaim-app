/**
 * Chooses which kinds of resources Reclaim's on-device AI shows for a message, and how many of
 * each, then orders candidates within a kind -- using the person's thumbs up/down
 * (resourceFeedback.js). Plain arithmetic, no model: it runs on every message and has to be
 * instant (a model-based pick took ~16 s on a Pixel 8a), and it has to be explainable.
 *
 * Decisions this encodes (Nathaniel, 2026-10-06 -- see PURPOSE.md):
 * - Up to 3 kinds and 4 items per reply (2 at most of any one kind).
 * - Explicit asks are always honored, whatever the person has rated. Learning only decides which
 *   kinds get added unasked and the order within a kind.
 * - Unasked kinds are only added when the message asks for something or names a feeling/urge, and
 *   only kinds that fit that theme -- small talk still gets no cards.
 * - Before any ratings: a theme -> kinds default map, nudged by the coping methods picked in
 *   onboarding. Ratings take over from there.
 * - A little randomness, so close calls vary and people find things they haven't rated.
 * - The accountability partner is never added or removed by learning: shown whenever asked for.
 * Basic mode doesn't use any of this.
 */
const ResourcePicker = (function () {
  const MAX_TYPES = 3;
  const MAX_ITEMS = 4;
  const PER_TYPE_MAX = 2;
  // Tools that only ever return one item.
  const SINGLE_ITEM = new Set(["scripture_search", "devotional_finder"]);

  // Kinds that fit each theme (AGENT_THEME_WORDS in agentTools.js), best first. This is the cold
  // start: the first kind is how a named feeling was always answered (a verse, before this), and
  // the rest are what an unasked addition may draw from. "in-the-moment" is an urge happening now.
  const THEME_TYPES = {
    "in-the-moment": ["coping_toolkit", "scripture_search"],
    shame: ["scripture_search", "devotional_finder"],
    temptation: ["coping_toolkit", "scripture_search"],
    loneliness: ["scripture_search", "small_group_finder", "devotional_finder"],
    anxiety: ["coping_toolkit", "scripture_search"],
    stress: ["coping_toolkit", "devotional_finder", "scripture_search"],
    hope: ["scripture_search", "devotional_finder"],
    relapse: ["scripture_search", "devotional_finder", "small_group_finder"],
    grace: ["scripture_search", "devotional_finder"],
    identity: ["scripture_search", "devotional_finder"],
    freedom: ["scripture_search", "bible_plan_finder"],
    perseverance: ["scripture_search", "bible_plan_finder"],
    accountability: ["scripture_search", "small_group_finder"],
    community: ["small_group_finder", "scripture_search"],
    triggers: ["coping_toolkit", "article_finder"],
    growth: ["bible_plan_finder", "devotional_finder"],
    struggle: ["scripture_search", "coping_toolkit"],
  };
  const MAP_PRIOR = [1.0, 0.7, 0.55];
  // A kind outside the map whose own content is tagged with the theme (e.g. a devotional on
  // "temptation") -- relevant, but it only gets added if the person has clearly liked it.
  const TAGGED_PRIOR = 0.4;
  // An explicit ask with no feeling named ("find me a group") has no theme to match, so only a
  // clearly liked kind rides along: needs a net score of about +0.4 (two or more thumbs up).
  const NO_THEME_PRIOR = 0.2;
  const EXTRA_THRESHOLD = 0.6;
  const PREF_WEIGHT = 1.0;
  const ONBOARDING_BONUS = 0.2;
  const TYPE_NOISE = 0.1;

  // Onboarding's preferred coping methods (COPING_METHOD_OPTIONS) -> the kind they point to.
  // "Accountability partner" maps to nothing on purpose: see the header.
  const METHOD_TO_TOOL = {
    Scripture: "scripture_search",
    Devotional: "devotional_finder",
    Breathing: "coping_toolkit",
    Journaling: "coping_toolkit",
    Walk: "coping_toolkit",
  };

  const TOOL_RESOURCE_TYPE = {
    scripture_search: "scripture",
    devotional_finder: "devotional",
    coping_toolkit: "coping_mechanism",
    bible_plan_finder: "bible_plan",
  };

  // Item ranking weights: theme match outranks everything learned, so a liked keyword never pulls
  // in something off-topic; preferences and the onboarding method decide among on-topic items.
  // ITEM_THEME has to exceed the widest swing of the rest (method 0.5 + prefs +/-0.8 + noise 0.2 =
  // 2.3) -- at 1.0, an off-topic liked item beat an on-topic disliked one in the offline test.
  const ITEM_THEME = 3.0;
  const ITEM_METHOD = 0.5;
  const ITEM_PREF = 0.8;
  const ITEM_NOISE = 0.2;
  const MILES_PER_POINT = 100;

  const toolScore = (profile, tool) => (profile && profile.tools[tool] ? profile.tools[tool].score : 0);
  const noise = (size) => (Math.random() - 0.5) * size;

  function themedTool(name) {
    const def = AGENT_TOOL_DEFS.find((t) => t.name === name);
    return !!(def && def.themed);
  }

  function hasTaggedContent(tool, theme) {
    const type = TOOL_RESOURCE_TYPE[tool];
    return !!(type && typeof ResourceRepo !== "undefined" && ResourceRepo.hasTheme(type, theme));
  }

  // How well an unasked kind fits: theme relevance + learned preference + onboarding + noise.
  function typeScore(tool, theme, profile, preferredMethods) {
    let prior = 0;
    if (theme) {
      const mapped = (THEME_TYPES[theme] || []).indexOf(tool);
      if (mapped >= 0) prior = MAP_PRIOR[mapped] ?? MAP_PRIOR[MAP_PRIOR.length - 1];
      else if (hasTaggedContent(tool, theme)) prior = TAGGED_PRIOR;
      else return null; // nothing to say about this theme -- never offered unasked
    } else {
      prior = NO_THEME_PRIOR;
    }
    const onboarding = preferredMethods.some((m) => METHOD_TO_TOOL[m] === tool) ? ONBOARDING_BONUS : 0;
    return prior + PREF_WEIGHT * toolScore(profile, tool) + onboarding + noise(TYPE_NOISE);
  }

  // Trims the per-kind counts to the item budget: later (lower-priority) kinds give up items first,
  // and a kind is dropped only when it's down to one item. The accountability partner is never
  // trimmed -- it shows every partner they've added.
  function allocate(picks) {
    const total = () => picks.reduce((n, p) => n + p.limit, 0);
    while (total() > MAX_ITEMS) {
      const shrink = [...picks].reverse().find((p) => p.limit > 1 && p.resource !== "accountability_match");
      if (shrink) shrink.limit -= 1;
      else picks.splice(picks.map((p) => p.resource !== "accountability_match").lastIndexOf(true), 1);
    }
    return picks;
  }

  /**
   * [{ resource, theme, explicit, limit }] for this message, best first; [] means no cards.
   * profile: ResourceFeedback.profile(); preferredMethods: onboarding's coping methods.
   */
  function pick(userText, lastReply = "", { profile = null, preferredMethods = [] } = {}) {
    // A short "yes" answers whatever the last reply offered, so it's matched against that reply.
    let lower = userText.toLowerCase();
    if (AGENT_AFFIRMATIVE.test(userText) && userText.length < 40 && lastReply) lower = lastReply.toLowerCase();

    const explicit = AGENT_TOOL_DEFS.map((t) => ({ name: t.name, score: agentScoreTool(t, lower) }))
      .filter((s) => s.score >= AGENT_MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .map((s) => s.name);

    // "Are you a pastor?" names no need, even if it contains a feeling word.
    const feeling = /\bare you\b/.test(lower) ? null : agentInferTheme(lower);
    // An urge happening now counts as a theme for unasked additions even without a feeling word.
    const theme = feeling || (explicit.includes("coping_toolkit") ? "in-the-moment" : null);
    if (!explicit.length && !feeling) return [];

    const picks = explicit.slice(0, MAX_TYPES).map((name) => ({ resource: name, explicit: true }));

    if (picks.length < MAX_TYPES) {
      const taken = new Set(picks.map((p) => p.resource));
      const candidates = AGENT_TOOL_DEFS.map((t) => t.name)
        .filter((name) => name !== "accountability_match" && !taken.has(name))
        .map((name) => ({ name, score: typeScore(name, theme, profile, preferredMethods) }))
        .filter((c) => c.score !== null)
        .sort((a, b) => b.score - a.score);

      // A feeling with no explicit ask always gets its best-fitting kind, liked or not -- naming a
      // feeling has always brought up a resource, and pointing to scripture was a user ask.
      if (!picks.length && candidates.length) picks.push({ resource: candidates.shift().name, explicit: false });
      for (const c of candidates) {
        if (picks.length >= MAX_TYPES) break;
        if (c.score >= EXTRA_THRESHOLD) picks.push({ resource: c.name, explicit: false });
      }
    }

    // "in-the-moment" is a coping-tool tag; a verse or devotional added for an urge should be about temptation
    // (otherwise it fell back to an unrelated Today's Verse).
    const urgeTheme = (tool) => (tool === "coping_toolkit" ? "in-the-moment" : "temptation");
    picks.forEach((p, i) => {
      p.theme = themedTool(p.resource) ? feeling || (theme === "in-the-moment" || p.resource === "coping_toolkit" ? urgeTheme(p.resource) : null) : null;
      const max = SINGLE_ITEM.has(p.resource) ? 1 : PER_TYPE_MAX;
      // The first kind (what they asked for, or the best fit) gets the most room; additions start at one.
      p.limit = p.explicit || i === 0 ? max : 1;
    });
    return allocate(picks);
  }

  /**
   * A rank(rows) function for ResourceRepo: best-first by theme match, onboarding method, learned
   * keyword preferences, distance (groups with a saved home location), and a little noise.
   */
  function ranker(tool, theme, profile, preferredMethods = []) {
    const keywordScores = profile ? profile.keywords : {};
    const score = (item) => {
      let s = 0;
      const tags = Array.isArray(item.tags) ? item.tags : [];
      if (theme && tags.includes(theme)) s += ITEM_THEME;
      if (item.method && preferredMethods.includes(item.method)) s += ITEM_METHOD;
      // Average over the keywords they've actually rated, so unrated tags don't dilute a clear signal.
      const rated = ResourceFeedback.keywordsFor(tool, item)
        .map((k) => keywordScores[k])
        .filter(Boolean);
      if (rated.length) s += ITEM_PREF * (rated.reduce((n, k) => n + k.score, 0) / rated.length);
      if (item.distanceMeters != null) s -= item.distanceMeters / 1609.34 / MILES_PER_POINT;
      return s + noise(ITEM_NOISE);
    };
    return (rows) =>
      rows
        .map((row) => ({ row, s: score(row) }))
        .sort((a, b) => b.s - a.s)
        .map((x) => x.row);
  }

  // ---- The app's own intro sentence for a multi-kind reply (the model never describes cards) ----

  function count(output) {
    const list = output && (output.plans || output.articles || output.mechanisms || output.groups || output.sermons || output.centers || output.contacts);
    return Array.isArray(list) ? list.length : 1;
  }

  function phrase(tool, theme, output) {
    const n = count(output);
    const about = theme && theme !== "in-the-moment" ? ` about ${theme}` : "";
    switch (tool) {
      case "scripture_search":
        return output && output.todaysVerse ? "today's verse from YouVersion" : `a verse${about}`;
      case "devotional_finder":
        return `a short devotional${about}`;
      case "bible_plan_finder":
        return n === 1 ? "a Bible reading plan you could start" : "some Bible reading plans you could start";
      case "article_finder":
        return n === 1 ? "an article that might help" : "some articles that might help";
      case "sermon_library":
        return n === 1 ? "a sermon you might find helpful" : "some sermons you might find helpful";
      case "counseling_directory":
        return n === 1 ? "a counselor you could reach out to" : "some counselors you could reach out to";
      case "small_group_finder":
        return n === 1 ? "a recovery group you could look into" : "some recovery groups you could look into";
      case "coping_toolkit":
        return n === 1 ? "something that can help right now" : "a few things that can help right now";
      case "accountability_match":
        if (!n || !(output && output.contacts && output.contacts.length)) return "a way to add an accountability partner";
        return n === 1 ? "your accountability partner's contact" : "your accountability partners' contacts";
      default:
        return "something that might help";
    }
  }

  // [{ resource, theme, output }] -> "I found a verse about loneliness, a short devotional, and some
  // recovery groups you could look into."
  function intro(results) {
    const parts = results.map((r) => phrase(r.resource, r.theme, r.output));
    if (parts.length === 1) return `I found ${parts[0]}.`;
    const list = parts.length === 2 ? parts.join(" and ") : `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
    return `I found ${list}.`;
  }

  return { pick, ranker, intro, THEME_TYPES, MAX_TYPES, MAX_ITEMS };
})();
