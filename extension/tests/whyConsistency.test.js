// Run: node extension/tests/whyConsistency.test.js
// The "why am I seeing this?" shown on the full-screen check-in (and in the in-app alert) must be
// ACCURATE: every reason has to correspond to a factor that really fired, the points must add up to
// the score, and nothing that didn't fire may be claimed. This hammers the scorer with thousands of
// random situations and checks that its explanation (userReasons / factors / trace) agrees with the
// arithmetic. It tests the browser port; RiskScorer.java mirrors it line for line (same weights,
// reasons and trace shape), but is only exercised on a device.
const assert = require("node:assert/strict");
const Shared = require("../lib/shared.js");
globalThis.ReclaimShared = Shared;
const R = require("../lib/riskScorer.js");
const N = require("../lib/notificationText.js");

// Tiny seeded PRNG so a failure is reproducible.
let seed = 20261007;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const maybe = (p = 0.5) => rnd() < p;

// What each fired factor must say to the person (the exact strings the UI shows).
const REASON_FOR = {
  triggerApp: /flagged as a trigger/,
  duration: /been there for \d+ minutes/,
  selfReportedTime: /time of day you told us is hard/,
  historicalTime: /difficult for you before/,
  socialMedia: /social media site/,
  recentKeywordSevere: /explicit was just seen/,
  recentKeyword: /matched a word or phrase you'd flagged/,
  recentKeywordMild: /word or phrase worth noticing/,
};
const CONVERGENCE = /lining up right now/;

const DOMAINS = ["old.reddit.com", "youtube.com", "instagram.com", "example.com", "news.site", "pornhub.com"];
const BUCKETS = ["Morning", "Afternoon", "Evening", "Night"];

let checked = 0, triggered = 0;
for (let i = 0; i < 6000; i++) {
  const hour = Math.floor(rnd() * 24);
  const bucket = R.timeBucket(hour);
  const input = {
    domain: pick(DOMAINS),
    sessionMinutes: maybe(0.2) ? 0 : Math.floor(rnd() * 90),
    hour,
    triggerDomains: maybe(0.7) ? Shared.DEFAULT_TRIGGER_DOMAINS : [],
    context: {
      intensity: pick(["low", "medium", "high", undefined]),
      temptingTimes: maybe(0.4) ? [pick(BUCKETS), bucket].filter(() => maybe(0.7)) : [],
      riskyTimeBuckets: maybe(0.4) ? [pick(BUCKETS), bucket].filter(() => maybe(0.7)) : [],
      commonTriggers: maybe(0.5) ? ["Social media"] : [],
      topSlipTags: maybe(0.3) ? ["Social media"] : [],
    },
    storedWeights: maybe(0.3) ? { triggerApp: 15 + Math.floor(rnd() * 31), duration: 15 + Math.floor(rnd() * 31) } : null,
    keywordSeverity: pick([null, null, null, "mild", "moderate", "severe"]),
    minutesSinceReclaimOpen: pick([-1, -1, 3, 29, 30, 31, 500]),
  };
  const r = R.score(input);
  const t = r.trace;
  const msg = `case ${i}: ${JSON.stringify({ ...input, storedWeights: !!input.storedWeights })}`;

  // 1. every fired factor has exactly one matching reason, and every reason is backed by a fired factor
  const fired = t.factors.filter((f) => f.fired);
  assert.deepEqual(fired.map((f) => f.id), r.factors, msg);
  const reasons = r.userReasons.filter((s) => !CONVERGENCE.test(s));
  assert.equal(reasons.length, fired.length, msg);
  fired.forEach((f, idx) => assert.match(reasons[idx], REASON_FOR[f.id], `${msg} :: ${f.id}`));
  // 2. factors that did NOT fire are all zero points and never claimed
  for (const f of t.factors.filter((x) => !x.fired)) assert.equal(f.points, 0, msg);
  // 3. the points add up: fired + fixed adjustments, floored at 0 (the protective subtraction can't go negative)
  const firedPts = fired.reduce((n, f) => n + f.points, 0);
  const adjPts = (t.adjustments || []).reduce((n, a) => n + a.points, 0);
  assert.equal(r.score, Math.max(0, firedPts + adjPts) === r.score ? r.score : -1, msg);
  assert.ok(r.score === firedPts + adjPts || r.score === 0, `${msg} :: ${r.score} != ${firedPts}+${adjPts}`);
  assert.equal(t.score, r.score, msg);
  // 4. convergence is stated exactly when 3+ distinct factors fired, with the right bonus
  const conv = (t.adjustments || []).find((a) => a.id === "convergence");
  assert.equal(!!conv, fired.length >= 3, msg);
  assert.equal(r.userReasons.some((s) => CONVERGENCE.test(s)), fired.length >= 3, msg);
  if (conv) assert.equal(conv.points, fired.length >= 4 ? 30 : 15, msg);
  // 5. the protective factor applies exactly inside the 30-minute window
  const prot = (t.adjustments || []).find((a) => a.id === "recentReclaimUse");
  const inWindow = input.minutesSinceReclaimOpen >= 0 && input.minutesSinceReclaimOpen <= 30;
  assert.equal(!!prot, inWindow, msg);
  // 6. threshold and high-risk agree with the intensity
  const thr = { low: 90, high: 35 }[input.context.intensity] || 60;
  assert.equal(t.threshold, thr, msg);
  assert.equal(r.triggers, r.score >= thr, msg);
  assert.equal(t.highRisk, r.score >= thr + 20, msg);
  // 7. the duration reason quotes the real minutes
  if (fired.some((f) => f.id === "duration")) assert.ok(r.userReasons.some((s) => s.includes(`${input.sessionMinutes} minutes`)), msg);
  // 8. only one keyword tier is ever claimed, and severe always triggers
  assert.ok(fired.filter((f) => /^recentKeyword/.test(f.id)).length <= 1, msg);
  if (input.keywordSeverity === "severe") assert.ok(fired.some((f) => f.id === "recentKeywordSevere"), msg);

  // 9. what the lock screen / overlay SAYS is backed by the same trace: it never names a factor that
  //    didn't fire, never mentions the app unless it did, and keyword factors never reveal more than the fixed line.
  const text = N.compose({ trace: t.factors, app: input.domain, minutes: input.sessionMinutes, timeBucket: t.timeBucket, bank: null, pick: () => 0 });
  const ids = new Set(fired.map((f) => f.id));
  if (text) {
    if (/\d+ minutes/.test(text)) { assert.ok(ids.has("duration"), `${msg} :: "${text}"`); assert.ok(text.includes(`${input.sessionMinutes} minutes`), `${msg} :: "${text}"`); }
    if (/flagged as a trigger/.test(text)) assert.ok(ids.has("triggerApp"), `${msg} :: "${text}"`);
    if (/scrolling/.test(text)) assert.ok(ids.has("socialMedia"), `${msg} :: "${text}"`);
    if (/time of day/.test(text)) assert.ok(ids.has("selfReportedTime") || ids.has("historicalTime"), `${msg} :: "${text}"`);
    if (/quiet around you/.test(text)) assert.ok(ids.has("alone"), `${msg} :: "${text}"`);
    if (/caught our attention/.test(text)) assert.ok([...ids].some((x) => /^recentKeyword/.test(x)), `${msg} :: "${text}"`);
    assert.ok(!/porn|explicit|nsfw|keyword/i.test(text.split(input.domain).join("")), `${msg} :: "${text}"`); // the app/site NAME is separate (see below)
  } else {
    // no sentence only when nothing speakable fired
    assert.ok(![...ids].some((x) => N.PRIORITY.includes(x) && x !== "alone"), `${msg} :: no text but ${[...ids]}`);
  }
  // 10. With a note bank, the note chosen for this situation may only claim what actually fired:
  //     "a hard time of day" iff a time factor fired, "no one else" iff nobody-nearby fired, a minutes figure iff duration fired.
  const bank = {};
  for (const sig of ["D", "DT", "DL", "DTL", "A", "AT", "AL", "ATL"]) {
    const head = sig[0] === "D" ? "You've been on {app} for {minutes} minutes {time}" : "You're on {app} {time}";
    bank[sig] = [head + (sig.includes("T") ? ", a hard time of day for you" : "") + (sig.includes("L") ? ", and no one else seems to be nearby" : "") + ". Take a moment to pause and check in."];
  }
  const noted = N.compose({ trace: t.factors, app: input.domain, minutes: input.sessionMinutes, timeBucket: t.timeBucket, bank: null, noteBank: bank, pick: () => 0 });
  if (noted && /pause and check in/.test(noted)) {
    assert.equal(/hard time of day/.test(noted), ids.has("selfReportedTime") || ids.has("historicalTime"), `${msg} :: "${noted}"`);
    assert.equal(/no one else/.test(noted), ids.has("alone"), `${msg} :: "${noted}"`);
    assert.equal(/ minutes /.test(noted), ids.has("duration"), `${msg} :: "${noted}"`);
    if (/ minutes /.test(noted)) assert.ok(noted.includes(`${input.sessionMinutes} minutes`), `${msg} :: "${noted}"`);
    assert.ok(!/\{[a-z]+\}/.test(noted), `unfilled slot: ${noted}`);
    assert.ok([...ids].every((x) => !/^recentKeyword/.test(x)), "keyword nudges never get a note");
  }
  checked++;
  if (r.triggers) triggered++;
}
console.log(`why-consistency: ${checked} random situations checked (${triggered} would trigger a nudge)`);
