/**
 * Today's passage for Home and the Lectio Divina meditation (lectioView.js): one of DAILY_PASSAGES
 * (seedData.js) a day. Replaced YouVersion's Verse of the Day (Nathaniel, 2026-10-07).
 *
 * Each install goes through every passage in its own shuffled order before any repeats (decision:
 * shuffled per person, not one shared sequence). The order and the day it started are kept in
 * app_meta, so the passage stays the same all day and survives restarts. Days are local calendar
 * days. After the last passage a new shuffle starts -- never opening with the passage just shown.
 * If passages are added, the round in progress finishes and the next round includes them; if any are
 * removed, a fresh cycle starts that day.
 *
 * The NEXT round is drawn ahead of time (schedule()), because the notifiers -- the browser extension
 * and Android's RiskNudgeMonitor -- offer today's passage on a nudge while the app is closed, so they
 * are handed the upcoming days' passages (PassageBank.getPlan). Once drawn, the next round is the one
 * used when the current round ends, so what a notification offered and what Home shows always agree.
 *
 * Needs DB.init() to have resolved (HomeView only renders after it).
 */
const DailyPassage = (function () {
  const META_KEY = "daily_passage_cycle"; // JSON { start: dayNumber, refs: [reference, ...], next?: [...] }
  // Passages already offered or prayed through in the app today, so a nudge later the same day offers a
  // different one ("never the same one twice in a day", Nathaniel 2026-10-07). JSON { day, refs }.
  const USED_KEY = "passages_used_today";

  // Local calendar day as a whole number (days since 1970-01-01 in the person's own time zone).
  // RiskPassage.java and extension/lib/passagePicker.js compute the same number.
  function dayNumber(date = new Date()) {
    return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
  }

  function passages() {
    return typeof DAILY_PASSAGES !== "undefined" ? DAILY_PASSAGES : [];
  }

  function byRef(reference) {
    return passages().find((p) => p.reference === reference) || null;
  }

  function shuffle(items) {
    const a = items.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // A round of every passage, not opening with `avoidFirst` (yesterday's passage) when there's a choice.
  function drawRound(refs, avoidFirst) {
    const order = shuffle(refs);
    if (order.length > 1 && order[0] === avoidFirst) [order[0], order[1]] = [order[1], order[0]];
    return order;
  }

  function sameList(list, refs) {
    return Array.isArray(list) && list.length === refs.length && refs.every((r) => list.includes(r));
  }

  function readCycle() {
    try {
      const c = JSON.parse(DB.getMeta(META_KEY) || "null");
      return c && Number.isInteger(c.start) && Array.isArray(c.refs) ? c : null;
    } catch (e) {
      return null;
    }
  }

  function save(cycle) {
    try {
      DB.setMeta(META_KEY, JSON.stringify(cycle));
      DB.scheduleSave();
    } catch (e) {}
    return cycle;
  }

  // The cycle that covers `day`, rolled forward (and saved) as needed.
  function cycleFor(day, refs) {
    const cycle = readCycle();
    // Passages only ADDED (2026-10-07: six on temptation): the round in progress carries on, so today's
    // passage doesn't change under anyone; the new ones join from the next round. A removed passage
    // could be in the round, so that starts a fresh one.
    const stillValid = cycle && cycle.refs.length > 0 && cycle.refs.every((r) => refs.includes(r));
    if (!stillValid || day < cycle.start) return save({ start: day, refs: drawRound(refs, null) });
    const len = cycle.refs.length;
    if (day - cycle.start < len) return cycle;
    // The round is over. Count from where the next one should have begun, so a person who skips a few
    // days just carries on rather than restarting from today.
    const rounds = Math.floor((day - cycle.start) / len);
    // The next round was drawn ahead of time and may already have been handed to the notifiers: use it.
    if (rounds === 1 && sameList(cycle.next, refs)) return save({ start: cycle.start + len, refs: cycle.next });
    return save({ start: cycle.start + rounds * len, refs: drawRound(refs, cycle.refs[len - 1]) });
  }

  /** { reference, description } for the given day (default today). */
  function today(date = new Date()) {
    const refs = passages().map((p) => p.reference);
    if (!refs.length) return null;
    const day = dayNumber(date);
    const cycle = cycleFor(day, refs);
    return byRef(cycle.refs[day - cycle.start]);
  }

  /**
   * [{ day, ref }] from the given day through the end of the NEXT round (one to two rounds of days), drawing the next
   * round now if it hasn't been. For the notifiers, which can't run any of this while the app is closed.
   */
  function schedule(date = new Date()) {
    const refs = passages().map((p) => p.reference);
    if (!refs.length) return [];
    const day = dayNumber(date);
    let cycle = cycleFor(day, refs);
    const len = cycle.refs.length;
    if (!sameList(cycle.next, refs)) cycle = save({ ...cycle, next: drawRound(refs, cycle.refs[len - 1]) });
    const out = [];
    for (let d = day; d < cycle.start + 2 * len; d++) {
      const i = d - cycle.start;
      out.push({ day: d, ref: i < len ? cycle.refs[i] : cycle.next[i - len] });
    }
    return out;
  }

  /** References offered or prayed through in the app today. */
  function usedToday(date = new Date()) {
    try {
      const u = JSON.parse(DB.getMeta(USED_KEY) || "null");
      return u && u.day === dayNumber(date) && Array.isArray(u.refs) ? u.refs : [];
    } catch (e) {
      return [];
    }
  }

  function markUsed(reference, date = new Date()) {
    if (!reference) return;
    const refs = usedToday(date);
    if (refs.includes(reference)) return;
    try {
      DB.setMeta(USED_KEY, JSON.stringify({ day: dayNumber(date), refs: [...refs, reference] }));
      DB.scheduleSave();
    } catch (e) {}
  }

  return { today, dayNumber, schedule, usedToday, markUsed, byRef };
})();
