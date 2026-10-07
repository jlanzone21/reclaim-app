/**
 * Thumbs up/down on Chat's resource cards, and the per-user preference profile learned from them.
 * Everything here is local (the resource_feedback table in db.js) and never sent anywhere.
 *
 * Decisions this encodes (Nathaniel, 2026-10-06 -- see PURPOSE.md):
 * - Learning is about kinds of resources (the tool: verses, devotionals, coping tools, groups...)
 *   and keywords (an item's tags, coping method, and verse topic), never the specific item. A
 *   thumbs-down on one devotional teaches "fewer devotionals / fewer of these themes", not "hide
 *   this card".
 * - The accountability partner can't be rated at all: it's the most important resource and
 *   learning must never make it show up less. Counselors and small groups CAN be rated and shown
 *   less -- for some people a given kind of group really isn't helpful.
 * - Recent ratings count most; each one fades with a ~60-day half-life, so someone can grow out of
 *   an old dislike without having to reset everything.
 * - Only the on-device AI mode (ReclaimAgent) shows thumbs and uses this; Basic mode is left as is.
 */
const ResourceFeedback = (function () {
  const HALF_LIFE_DAYS = 60;
  // Pseudo-count added to every score's denominator, so one or two ratings nudge preferences
  // instead of swinging them all the way: a single thumbs-down scores -1/3, not -1.
  const PRIOR = 2;
  const NOT_RATEABLE = new Set(["accountability_match", "encouragement"]);
  const SUPABASE_TOOLS = new Set(["small_group_finder", "sermon_library", "article_finder", "counseling_directory"]);

  const TOOL_LABELS = {
    scripture_search: "Bible verses",
    devotional_finder: "Devotionals",
    bible_plan_finder: "Bible reading plans",
    coping_toolkit: "Coping tools",
    article_finder: "Articles",
    sermon_library: "Sermons",
    small_group_finder: "Small groups",
    counseling_directory: "Counselors",
  };

  function rateable(tool) {
    return !NOT_RATEABLE.has(tool);
  }

  function normalizeKeyword(k) {
    return String(k).trim().toLowerCase();
  }

  // None of the Supabase rows (groups, counselors, sermons, articles) have tags (checked
  // 2026-10-06), so their keywords are derived from what they do have: the format, and the
  // ministry/speaker named in the subtitle ("John Piper · Desiring God", "Pure Desire Ministries").
  const FORMAT_WORDS = [
    [/\bonline\b|\bvirtual\b/i, "online"],
    [/\bphone\b/i, "phone"],
    [/\bin[- ]person\b/i, "in-person"],
    [/\bnational\b/i, "national"],
    [/\bchurch[- ]based\b/i, "church-based"],
    [/\bmen'?s\b|\bfor men\b/i, "for men"],
    [/\bwomen'?s\b|\bfor women\b/i, "for women"],
    [/\bcelebrate recovery\b/i, "celebrate recovery"],
    [/\b(?:12|twelve)[- ]step\b/i, "12-step"],
    [/\bspouses?\b|\bwives\b|\bbetrayed\b/i, "for spouses"],
    [/\bmarriage\b|\bcouples?\b/i, "marriage"],
  ];
  // Subtitle parts that describe the listing, not who's behind it.
  const GENERIC_SOURCE = /^(national|regional|local|online|phone|directory|group finder|topic hub)\b/i;

  function derivedKeywords(item) {
    const out = [];
    const text = [item.title, item.subtitle, item.area].filter(Boolean).join(" ");
    for (const [re, word] of FORMAT_WORDS) if (re.test(text)) out.push(word);
    for (const part of String(item.subtitle || "").split(/·|\//)) {
      const source = part
        .split(",")[0]
        .replace(/\([^)]*\)+/g, "")
        .replace(/["“”]/g, "")
        .trim();
      if (source && source.length <= 40 && !GENERIC_SOURCE.test(source)) out.push(source);
    }
    return out;
  }

  // The keywords an item carries -- what a rating on it teaches and what ranking matches against.
  // The message's detected theme is deliberately NOT included -- that describes how the person
  // felt, not the resource, and a thumbs-down on a shame verse shouldn't teach "stop showing shame
  // help".
  function keywordsFor(tool, item) {
    const keywords = new Set();
    const add = (k) => {
      if (k) keywords.add(normalizeKeyword(k));
    };
    // Today's Verse is YouVersion's pick; any tags on it belong to an unrelated local verse that
    // agentFindVerse spreads in as a fallback, so only the tool itself is learned from it.
    if (item.todaysVerse) return [];
    (Array.isArray(item.tags) ? item.tags : []).forEach(add);
    add(item.method);
    add(item.topic);
    if (SUPABASE_TOOLS.has(tool)) derivedKeywords(item).forEach(add);
    return [...keywords];
  }

  function describe(tool, item) {
    let key;
    if (tool === "scripture_search") key = `verse:${item.title}`;
    else if (SUPABASE_TOOLS.has(tool)) key = `sb:${item.id}`;
    else key = `local:${tool}:${item.title}`;

    return { tool, key, keywords: keywordsFor(tool, item) };
  }

  // Inserts a new rating, or changes an existing one (a card switching from thumbs-up to -down).
  // Returns the row id the card should hold on to for later changes/undo.
  function rate(existingId, entry, rating) {
    if (!rateable(entry.tool)) return null;
    const now = new Date().toISOString();
    if (existingId) {
      DB.run("UPDATE resource_feedback SET rating = ?, created_at = ? WHERE id = ?", [rating, now, existingId]);
      DB.scheduleSave();
      return existingId;
    }
    DB.run("INSERT INTO resource_feedback (created_at, rating, tool, resource_key, keywords) VALUES (?, ?, ?, ?, ?)", [
      now,
      rating,
      entry.tool,
      entry.key,
      JSON.stringify(entry.keywords),
    ]);
    const id = DB.get("SELECT last_insert_rowid() AS id").id;
    DB.scheduleSave();
    return id;
  }

  function remove(id) {
    if (!id) return;
    DB.run("DELETE FROM resource_feedback WHERE id = ?", [id]);
    DB.scheduleSave();
  }

  function all() {
    return DB.all("SELECT * FROM resource_feedback ORDER BY created_at DESC").map((row) => ({
      ...row,
      keywords: row.keywords ? JSON.parse(row.keywords) : [],
    }));
  }

  function count() {
    return DB.get("SELECT COUNT(*) AS n FROM resource_feedback").n;
  }

  // "Forget" from Privacy: drops a tool's ratings entirely...
  function forgetTool(tool) {
    DB.run("DELETE FROM resource_feedback WHERE tool = ?", [tool]);
    DB.scheduleSave();
  }

  // ...or strips one keyword out of every rating while keeping what those ratings say about the
  // tool and their other keywords.
  function forgetKeyword(keyword) {
    const k = normalizeKeyword(keyword);
    for (const row of all()) {
      if (!row.keywords.includes(k)) continue;
      DB.run("UPDATE resource_feedback SET keywords = ? WHERE id = ?", [JSON.stringify(row.keywords.filter((x) => x !== k)), row.id]);
    }
    DB.scheduleSave();
  }

  function clearAll() {
    DB.run("DELETE FROM resource_feedback");
    DB.scheduleSave();
  }

  function decayWeight(createdAt, now) {
    const ageDays = Math.max(0, (now - Date.parse(createdAt)) / 86400000);
    return Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
  }

  function bump(map, name, rating, weight) {
    const s = map[name] || (map[name] = { up: 0, down: 0 });
    if (rating > 0) s.up += weight;
    else s.down += weight;
  }

  function finalize(map) {
    for (const s of Object.values(map)) s.score = (s.up - s.down) / (s.up + s.down + PRIOR);
    return map;
  }

  // { tools: { coping_toolkit: { up, down, score } }, keywords: { grounding: {...} } }, where
  // up/down are decayed rating totals and score runs from -1 (consistently unhelpful) to +1.
  function profile(now = Date.now()) {
    const tools = {};
    const keywords = {};
    for (const row of all()) {
      const w = decayWeight(row.created_at, now);
      bump(tools, row.tool, row.rating, w);
      row.keywords.forEach((k) => bump(keywords, k, row.rating, w));
    }
    return { tools: finalize(tools), keywords: finalize(keywords) };
  }

  // Each rating with its current decay weight -- for the embedding "taste" (localEmbedder.js),
  // which looks at what rated things were about rather than their keywords.
  function weightedRows(now = Date.now()) {
    return all().map((row) => ({ key: row.resource_key, rating: row.rating, weight: decayWeight(row.created_at, now) }));
  }

  // One plain sentence for the on-device model's per-turn context (reclaimAgent.js), so when it
  // writes a no-card reply and names a kind of resource, it can lean toward ones that have helped.
  // Kinds and themes only -- never item names, which the model must not repeat.
  function summary(p = profile()) {
    const LEAN = 0.15;
    const pick = (map, sign, label) =>
      Object.entries(map)
        .filter(([, s]) => sign * s.score >= LEAN)
        .sort((a, b) => sign * (b[1].score - a[1].score))
        .slice(0, 4)
        .map(([name]) => label(name));
    const toolLabel = (t) => (TOOL_LABELS[t] || t).toLowerCase();
    const helpfulTools = pick(p.tools, 1, toolLabel);
    const helpfulThemes = pick(p.keywords, 1, (k) => k);
    const lessTools = pick(p.tools, -1, toolLabel);
    const parts = [];
    if (helpfulTools.length || helpfulThemes.length) {
      parts.push(`found helpful: ${[...helpfulTools, ...helpfulThemes.map((k) => `"${k}"`)].join(", ")}`);
    }
    if (lessTools.length) parts.push(`found less helpful: ${lessTools.join(", ")}`);
    return parts.length ? `In this app they have ${parts.join("; and ")}.` : "";
  }

  return {
    HALF_LIFE_DAYS,
    TOOL_LABELS,
    rateable,
    keywordsFor,
    describe,
    rate,
    remove,
    all,
    count,
    forgetTool,
    forgetKeyword,
    clearAll,
    profile,
    weightedRows,
    summary,
  };
})();
