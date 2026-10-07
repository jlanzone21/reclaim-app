/**
 * Chooses which kinds of resources Reclaim's on-device AI shows for a message, and how many of
 * each, then orders candidates within a kind -- using the person's thumbs up/down
 * (resourceFeedback.js). Plain arithmetic, no chat model: it runs on every message and has to be
 * instant (a model-based pick took ~16 s on a Pixel 8a), and it has to be explainable. When the
 * small embedding model is loaded (localEmbedder.js), its signals feed in too -- a feeling or ask
 * the keywords missed, and closeness in meaning/taste -- but everything works without it.
 *
 * Decisions this encodes (Nathaniel, 2026-10-06 -- see PURPOSE.md):
 * - Up to 3 kinds and 4 items per reply (2 at most of any one kind).
 * - Explicit asks are always honored, whatever the person has rated. Learning only decides which
 *   kinds get added unasked and the order within a kind.
 * - Unasked kinds are only added when the message names a feeling or urge, and only kinds that fit
 *   it -- a direct ask gets just what was asked for (2026-10-07), small talk gets no cards.
 * - Items already shown in this conversation rank lower, so liked items rotate (2026-10-07).
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
  // Theme words that are really requests, not feelings (see pick).
  const REQUEST_THEMES = new Set(["accountability"]);
  // What makes a coping request an urge happening now (see pick).
  const URGE_WORDS = /\b(?:urges?|crav\w*|tempt\w*|about to|(?:want|going) to (?:look|watch)|the pull|give in|giving in|act out)\b/;
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
  // in something off-topic; preferences, meaning and the onboarding method decide among on-topic
  // items. ITEM_THEME has to exceed the widest swing of the rest: method 0.5 + already shown 2.0 +
  // 2 x (prefs 0.8 + meaning 0.8 + taste 0.6 + noise 0.1) = 7.1 -- at 1.0, an off-topic liked item
  // beat an on-topic disliked one in the offline test.
  const ITEM_THEME = 8.0;
  // Already shown in this conversation: in the multi-like test one liked group came back in 5 of
  // 10 replies (all its keywords were liked). Bigger than a typical liked-keyword lead (~1), so
  // unseen on-topic items rotate in; smaller than a theme match, so a shown item still beats
  // anything off-topic.
  const ITEM_SHOWN = 2.0;
  const ITEM_METHOD = 0.5;
  const ITEM_PREF = 0.8;
  const ITEM_NOISE = 0.2;
  // Embedding terms (localEmbedder.js) use similarity relative to the other candidates, since raw
  // cosines all sit around 0.4-0.7: a candidate 0.1 closer in meaning than average gains 0.4.
  const ITEM_MEANING = 4.0;
  const ITEM_MEANING_CAP = 0.8;
  const ITEM_TASTE = 3.0;
  const ITEM_TASTE_CAP = 0.6;
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

  // How well an unasked kind fits the theme: relevance + learned preference + onboarding + noise.
  function typeScore(tool, theme, profile, preferredMethods) {
    let prior = 0;
    const mapped = (THEME_TYPES[theme] || []).indexOf(tool);
    if (mapped >= 0) prior = MAP_PRIOR[mapped] ?? MAP_PRIOR[MAP_PRIOR.length - 1];
    else if (hasTaggedContent(tool, theme)) prior = TAGGED_PRIOR;
    else return null; // nothing to say about this theme -- never offered unasked
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
   * profile: ResourceFeedback.profile(); preferredMethods: onboarding's coping methods;
   * inferred: { theme, ask } from the embedding model (localEmbedder.js), or null -- only used
   * when the keywords found nothing of that sort. An inferred ask counts as explicit (decision:
   * they did ask, in other words).
   */
  function pick(userText, lastReply = "", { profile = null, preferredMethods = [], inferred = null } = {}) {
    // A short "yes" answers whatever the last reply offered, so it's matched against that reply.
    let lower = userText.toLowerCase();
    const affirmative = AGENT_AFFIRMATIVE.test(userText) && userText.length < 40 && !!lastReply;
    if (affirmative) lower = lastReply.toLowerCase();
    const aboutAi = /\bare you\b/.test(lower);
    // What the embedding model read from "yes" says nothing; the last reply already carries the meaning.
    const hint = !affirmative && !aboutAi && inferred ? inferred : {};

    const explicit = AGENT_TOOL_DEFS.map((t) => ({ name: t.name, score: agentScoreTool(t, lower) }))
      .filter((s) => s.score >= AGENT_MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .map((s) => s.name);
    if (!explicit.length && hint.ask) explicit.push(hint.ask);

    // "Are you a pastor?" names no need, even if it contains a feeling word. An urge happening now
    // (coping asked for) outranks a feeling the embedding model only guessed at: with the real model,
    // "the craving won't go away" read as "hope" and pulled in hope content instead of urge help.
    const urgeNow = explicit.includes("coping_toolkit");
    const feeling = aboutAi ? null : agentInferTheme(lower) || (urgeNow ? null : hint.theme) || null;
    // An urge happening now counts as a theme for unasked additions even without a feeling word --
    // but only with urge language: "a verse and a coping tool please" asks for coping tools without
    // describing an urge, and is a direct ask like any other.
    const theme = feeling || (urgeNow && URGE_WORDS.test(lower) ? "in-the-moment" : null);
    if (!explicit.length && !feeling) return [];

    const picks = explicit.slice(0, MAX_TYPES).map((name) => ({ resource: name, explicit: true }));

    // Unasked kinds come only with a feeling or an urge (decision, 2026-10-07): a direct ask gets
    // what was asked for. With four kinds liked, every "find me a counselor" or "can you share a
    // verse" came back as a three-kind bundle. "accountability" doesn't count as a feeling here --
    // it's a theme word only because it's how people ask for their partner.
    if (picks.length < MAX_TYPES && theme && !REQUEST_THEMES.has(theme)) {
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
    // (otherwise it fell back to the theme-less default verse).
    const urgeTheme = (tool) => (tool === "coping_toolkit" ? "in-the-moment" : "temptation");
    picks.forEach((p, i) => {
      p.theme = themedTool(p.resource) ? feeling || (theme === "in-the-moment" || p.resource === "coping_toolkit" ? urgeTheme(p.resource) : null) : null;
      const max = SINGLE_ITEM.has(p.resource) ? 1 : PER_TYPE_MAX;
      // The first kind (what they asked for, or the best fit) gets the most room; additions start at one.
      p.limit = p.explicit || i === 0 ? max : 1;
    });
    return allocate(picks);
  }

  const clamp = (x, cap) => Math.max(-cap, Math.min(cap, x));

  // Similarity of each row's vector to `target`, minus the average over the rows that have one;
  // rows without a vector (not indexed yet) get 0, i.e. no opinion.
  function relativeSimilarity(rows, target, vectorFor, cosine) {
    const sims = rows.map((row) => {
      const v = vectorFor(row);
      return v ? cosine(target, v) : null;
    });
    const known = sims.filter((s) => s !== null);
    if (!known.length) return rows.map(() => 0);
    const mean = known.reduce((a, b) => a + b, 0) / known.length;
    return sims.map((s) => (s === null ? 0 : s - mean));
  }

  /**
   * A rank(rows) function for ResourceRepo: best-first by theme match, onboarding method, learned
   * keyword preferences, distance (groups with a saved home location), and a little noise -- plus,
   * when the embedding model is ready (`semantic`: { queryVec, taste, vectorFor(key), cosine }),
   * closeness in meaning to the message and to what they've rated helpful. `shown`: resource keys
   * already shown in this conversation, which rank lower.
   */
  function ranker(tool, theme, profile, preferredMethods = [], semantic = null, shown = null) {
    const keywordScores = profile ? profile.keywords : {};
    const score = (item, meaning, taste) => {
      let s = 0;
      const tags = Array.isArray(item.tags) ? item.tags : [];
      if (theme && tags.includes(theme)) s += ITEM_THEME;
      if (shown && shown.has(ResourceFeedback.describe(tool, item).key)) s -= ITEM_SHOWN;
      if (item.method && preferredMethods.includes(item.method)) s += ITEM_METHOD;
      // Average over the keywords they've actually rated, so unrated tags don't dilute a clear signal.
      const rated = ResourceFeedback.keywordsFor(tool, item)
        .map((k) => keywordScores[k])
        .filter(Boolean);
      if (rated.length) s += ITEM_PREF * (rated.reduce((n, k) => n + k.score, 0) / rated.length);
      if (item.distanceMeters != null) s -= item.distanceMeters / 1609.34 / MILES_PER_POINT;
      s += clamp(ITEM_MEANING * meaning, ITEM_MEANING_CAP) + clamp(ITEM_TASTE * taste, ITEM_TASTE_CAP);
      return s + noise(ITEM_NOISE);
    };
    return (rows) => {
      const zeros = rows.map(() => 0);
      let meaning = zeros;
      let taste = zeros;
      if (semantic && semantic.vectorFor) {
        const vecOf = (row) => semantic.vectorFor(ResourceFeedback.describe(tool, row).key);
        if (semantic.queryVec) meaning = relativeSimilarity(rows, semantic.queryVec, vecOf, semantic.cosine);
        if (semantic.taste) taste = relativeSimilarity(rows, semantic.taste, vecOf, semantic.cosine);
      }
      return rows
        .map((row, i) => ({ row, s: score(row, meaning[i], taste[i]) }))
        .sort((a, b) => b.s - a.s)
        .map((x) => x.row);
    };
  }

  /**
   * The verse topic the AI agent hands agentFindVerse for a pick: undefined when there's no
   * embedding model (agentFindVerse then keeps its old word-overlap match), null for "no topic",
   * or the meaning-matched { topic, refs }. A topic is only used when the verse is about a feeling
   * (the pick has a theme) or a verse is what was asked for: when a verse merely rides along with
   * another ask, the match is about the ask's wording -- "find me a recovery group" matched
   * "Recovering from a mistake", "give me a bible reading plan" matched "Understanding God's plan".
   */
  function verseTopicFor(pick, analysis) {
    if (pick.resource !== "scripture_search" || !analysis) return undefined;
    return pick.theme || pick.explicit ? analysis.verseTopic || null : null;
  }

  // ---- The app's own intro sentence for a multi-kind reply (the model never describes cards) ----

  // The items a tool's output shows: its list, or the single item (verse, devotional).
  function itemsOf(output) {
    if (!output) return [];
    const list = output.plans || output.articles || output.mechanisms || output.groups || output.sermons || output.centers || output.contacts;
    return Array.isArray(list) ? list : [output];
  }

  function count(output) {
    return itemsOf(output).length;
  }

  function phrase(tool, theme, output) {
    const n = count(output);
    const about = theme && theme !== "in-the-moment" ? ` about ${theme}` : "";
    switch (tool) {
      case "scripture_search":
        if (output && output.graceDefault) return "a verse about God's grace";
        return `a verse${about || (output && output.topic ? ` about ${output.topic.toLowerCase()}` : "")}`;
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

  return { pick, ranker, intro, verseTopicFor, itemsOf, THEME_TYPES, MAX_TYPES, MAX_ITEMS };
})();
