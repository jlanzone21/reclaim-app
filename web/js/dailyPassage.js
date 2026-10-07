/**
 * Today's passage for Home (and, later, the 2-minute devotional built on it): one of
 * DAILY_PASSAGES (seedData.js) a day. Replaced YouVersion's Verse of the Day (Nathaniel,
 * 2026-10-07).
 *
 * Each install goes through every passage in its own shuffled order before any repeats (decision:
 * shuffled per person, not one shared sequence). The order and the day it started are kept in
 * app_meta, so the passage stays the same all day and survives restarts. Days are local calendar
 * days. After the last passage a new shuffle starts -- never opening with the passage just shown.
 * If the list itself changes (passages added or removed), a fresh cycle starts that day.
 *
 * Needs DB.init() to have resolved (HomeView only renders after it).
 */
const DailyPassage = (function () {
  const META_KEY = "daily_passage_cycle"; // JSON { start: dayNumber, refs: [reference, ...] }

  // Local calendar day as a whole number (days since 1970-01-01 in the person's own time zone).
  function dayNumber(date = new Date()) {
    return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
  }

  function shuffle(items) {
    const a = items.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function readCycle() {
    try {
      const c = JSON.parse(DB.getMeta(META_KEY) || "null");
      return c && Number.isInteger(c.start) && Array.isArray(c.refs) ? c : null;
    } catch (e) {
      return null;
    }
  }

  function newCycle(start, refs, avoidFirst) {
    const order = shuffle(refs);
    // Don't show yesterday's passage again as the first of the new round.
    if (order.length > 1 && order[0] === avoidFirst) [order[0], order[1]] = [order[1], order[0]];
    const cycle = { start, refs: order };
    try {
      DB.setMeta(META_KEY, JSON.stringify(cycle));
      DB.scheduleSave();
    } catch (e) {}
    return cycle;
  }

  /** { reference, description } for the given day (default today). */
  function today(date = new Date()) {
    const passages = typeof DAILY_PASSAGES !== "undefined" ? DAILY_PASSAGES : [];
    if (!passages.length) return null;
    const refs = passages.map((p) => p.reference);
    const day = dayNumber(date);

    let cycle = readCycle();
    const sameList = cycle && cycle.refs.length === refs.length && refs.every((r) => cycle.refs.includes(r));
    if (!cycle || !sameList || day < cycle.start) {
      cycle = newCycle(day, refs, null);
    } else if (day - cycle.start >= cycle.refs.length) {
      // The round is over. Count from where the next one should have begun, so a person who skips
      // a few days just carries on rather than restarting from today.
      const rounds = Math.floor((day - cycle.start) / cycle.refs.length);
      const lastShown = cycle.refs[cycle.refs.length - 1];
      cycle = newCycle(cycle.start + rounds * cycle.refs.length, refs, lastShown);
    }
    const reference = cycle.refs[day - cycle.start];
    return passages.find((p) => p.reference === reference) || null;
  }

  return { today, dayNumber };
})();
