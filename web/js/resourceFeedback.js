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

  // What a rating on this card teaches: its tool plus the item's own descriptive keywords. The
  // message's detected theme is deliberately NOT included -- that describes how the person felt,
  // not the resource, and a thumbs-down on a shame verse shouldn't teach "stop showing shame help".
  function describe(tool, item, input) {
    const keywords = new Set();
    const add = (k) => {
      if (k) keywords.add(normalizeKeyword(k));
    };
    // Today's Verse is YouVersion's pick; any tags on it belong to an unrelated local verse that
    // agentFindVerse spreads in as a fallback, so only the tool itself is learned from it.
    if (!item.todaysVerse) {
      (Array.isArray(item.tags) ? item.tags : []).forEach(add);
      add(item.method);
      add(item.topic);
    }

    let key;
    if (tool === "scripture_search") key = `verse:${item.title}`;
    else if (SUPABASE_TOOLS.has(tool)) key = `sb:${item.id}`;
    else key = `local:${tool}:${item.title}`;

    return { tool, key, keywords: [...keywords] };
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

  return {
    HALF_LIFE_DAYS,
    TOOL_LABELS,
    rateable,
    describe,
    rate,
    remove,
    all,
    count,
    forgetTool,
    forgetKeyword,
    clearAll,
    profile,
  };
})();
