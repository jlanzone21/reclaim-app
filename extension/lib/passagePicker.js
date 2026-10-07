// Picks which daily passage a risk nudge offers to pray through ("Pray through Romans 8:31-39"), from the
// plan the app's on-device AI built while it was open (web/js/passageBank.js, synced as
// riskContext.passagePlan). Port of android/.../RiskPassage.java -- keep the two in step.
//
// The rule (Nathaniel, 2026-10-07): the first nudge of the day offers TODAY's passage (the same one Home
// shows); later nudges offer the passage the AI ranked best for this situation (which reasons fired, what
// time of day) -- and never one already offered or prayed through today. With no ranking (the embedding
// model isn't downloaded) the person's upcoming daily passages are used instead, in order.
(function (root) {
  // Local calendar day as a whole number -- the same number DailyPassage.dayNumber (web) and
  // RiskPassage.today (Android) compute.
  function dayNumber(date = new Date()) {
    return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
  }

  function keyFor(signature, bucket) {
    return `${signature || "K"}|${bucket || ""}`;
  }

  /**
   * @param {object} plan   { passages: {ref: description}, schedule: [{day, ref}], ranked: {key: [ref]}, used: {day, refs} }
   * @param {Set<string>} used  references already offered today (the caller's own record)
   * @param {string} key    keyFor(signature, bucket)
   * @param {number} day    dayNumber()
   * @returns {{ref: string, description: string, today: boolean}|null}
   */
  function choose(plan, used, key, day) {
    if (!plan || typeof plan !== "object") return null;
    const passages = plan.passages && typeof plan.passages === "object" ? plan.passages : {};
    const taken = new Set(used || []);
    if (plan.used && plan.used.day === day && Array.isArray(plan.used.refs)) plan.used.refs.forEach((r) => taken.add(r));
    const ok = (r) => typeof r === "string" && Object.prototype.hasOwnProperty.call(passages, r) && !taken.has(r);
    const pick = (ref, today = false) => ({ ref, description: String(passages[ref] || ""), today });

    const schedule = Array.isArray(plan.schedule) ? plan.schedule.filter((s) => s && typeof s.day === "number") : [];
    const todays = schedule.find((s) => s.day === day);
    if (todays && ok(todays.ref)) return pick(todays.ref, true);
    const ranked = plan.ranked && Array.isArray(plan.ranked[key]) ? plan.ranked[key] : [];
    for (const r of ranked) if (ok(r)) return pick(r);
    for (const s of schedule) if (s.day > day && ok(s.ref)) return pick(s.ref);
    for (const r of Object.keys(passages)) if (ok(r)) return pick(r);
    return null;
  }

  const api = { choose, keyFor, dayNumber };
  root.PassagePicker = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
