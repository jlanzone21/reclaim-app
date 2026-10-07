// Builds the risk-nudge notification text from what the scorer actually did (its trace), e.g.
// "You've been on reddit.com for 22 minutes. Let's check in." Port of
// android/.../RiskNotificationText.java -- keep the two in step.
//
// Where the wording comes from: the on-device AI (web/js/riskExplainer.js) writes several phrase
// templates per factor while the app is open and syncs them here as `bank`; this file only fills in
// the live values ({app}, {minutes}, {time}) at the moment a notification fires, because the model
// can't run while the app is closed. With no bank yet (model not downloaded, first run) the
// built-in phrases below are used, so a notification is never blank or generic by accident.
//
// The two exceptions: the keyword factors always use a fixed built-in line -- never AI wording, and
// never the matched word or what was on screen -- so a model can't be talking about explicit
// content on a lock screen. And when the user turns "lock-screen detail" off (a Privacy setting,
// default ON), compose() returns null and the caller falls back to the old generic text.
(function (root) {
  const TIME_WORDS = { Morning: "this morning", Afternoon: "this afternoon", Evening: "this evening", Night: "late tonight" };

  // Highest priority first: what's most specific to what's happening right now leads.
  const PRIORITY = ["recentKeywordSevere", "recentKeyword", "recentKeywordMild", "duration", "socialMedia", "triggerApp", "selfReportedTime", "historicalTime", "alone"];
  const KEYWORD_FACTORS = new Set(["recentKeywordSevere", "recentKeyword", "recentKeywordMild"]);
  // Both of these say "it's a hard time of day" -- one is enough in a single line.
  const TIME_FACTORS = new Set(["selfReportedTime", "historicalTime"]);

  const KEYWORD_LINE = "Something on your screen caught our attention.";
  const BUILTIN = {
    triggerApp: ["You're on {app}, which you flagged as a trigger."],
    duration: ["You've been on {app} for {minutes} minutes.", "That's {minutes} minutes on {app} now."],
    socialMedia: ["You've been scrolling on {app} {time}."],
    selfReportedTime: ["This is a time of day you said is hard."],
    historicalTime: ["This time of day has been tough for you before."],
    alone: ["It's quiet around you right now."],
  };
  const CLOSERS = ["Let's check in.", "Got a minute to check in?", "Want to check in?"];
  const MAX_LENGTH = 150; // the Android heads-up shows roughly this much before truncating

  const ALLOWED_PLACEHOLDER = /\{(?:app|minutes|time)\}/g;

  // A phrase from the synced bank is only used if it is still shaped like one: short, a single
  // sentence, and no placeholder other than the three we fill in. The app validated it when it was
  // written; this is the second check because it has crossed a storage boundary since.
  function usable(phrase) {
    if (typeof phrase !== "string") return false;
    const p = phrase.trim();
    if (!p || p.length > 90) return false;
    if (/\{[^}]*\}/.test(p.replace(ALLOWED_PLACEHOLDER, ""))) return false;
    return !/[.!?]\s+\S/.test(p);
  }

  function fill(phrase, values) {
    return phrase
      .replace(/\{app\}/g, values.app)
      .replace(/\{minutes\}/g, String(values.minutes))
      .replace(/\{time\}/g, values.time);
  }

  function sentenceFor(id, values, bank, pick) {
    if (KEYWORD_FACTORS.has(id)) return KEYWORD_LINE;
    const banked = ((bank && bank[id]) || []).filter(usable);
    const pool = banked.length ? banked : BUILTIN[id] || [];
    if (!pool.length) return null;
    return fill(pool[pick(pool.length)], values);
  }

  /**
   * @param {object} o
   * @param {object[]} o.trace         RiskScorer trace `factors` array: {id, fired, points, detail}
   * @param {string} o.app             app label / site domain
   * @param {number} o.minutes         session minutes
   * @param {string} o.timeBucket      Morning | Afternoon | Evening | Night
   * @param {object} [o.bank]          {factorId: string[], closer: string[]} written by the on-device AI
   * @param {boolean} o.detail         the user's lock-screen-detail setting
   * @param {function} [o.pick]        n => index in [0, n), injectable for tests
   * @returns {string|null} the text, or null when the caller should use the generic wording
   */
  function compose({ trace, app, minutes, timeBucket, bank, detail, pick }) {
    if (!detail) return null;
    const choose = pick || ((n) => Math.floor(Math.random() * n));
    const fired = new Set((trace || []).filter((f) => f.fired).map((f) => f.id));
    const values = { app: app || "this app", minutes: minutes || 0, time: TIME_WORDS[timeBucket] || "right now" };

    const lead = [];
    let sawTime = false;
    let namedApp = false;
    for (const id of PRIORITY) {
      if (!fired.has(id)) continue;
      if (TIME_FACTORS.has(id)) {
        if (sawTime) continue;
        sawTime = true;
      }
      const s = sentenceFor(id, values, bank, choose);
      if (!s) continue;
      // The app is named once: a second sentence repeating it just reads as noise.
      const names = s.includes(values.app);
      if (names && namedApp) continue;
      namedApp = namedApp || names;
      lead.push(s);
      if (lead.length === 2) break;
    }
    if (!lead.length) return null;

    const closers = ((bank && bank.closer) || []).filter(usable);
    const closer = closers.length ? closers[choose(closers.length)] : CLOSERS[choose(CLOSERS.length)];
    let text = `${lead.join(" ")} ${closer}`;
    // One lead sentence + the closer always fits; two only if short enough.
    if (text.length > MAX_LENGTH) text = `${lead[0]} ${closer}`;
    return text;
  }

  const api = { compose, usable, BUILTIN, CLOSERS, KEYWORD_LINE, TIME_WORDS, PRIORITY };
  root.NotificationText = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
