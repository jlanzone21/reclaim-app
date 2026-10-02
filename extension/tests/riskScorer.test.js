// Run: node extension/tests/riskScorer.test.js
const assert = require("node:assert/strict");
const Shared = require("../lib/shared.js");
globalThis.ReclaimShared = Shared;
const R = require("../lib/riskScorer.js");

const base = { domain: "example.com", sessionMinutes: 0, hour: 14, triggerDomains: Shared.DEFAULT_TRIGGER_DOMAINS,
  context: {}, storedWeights: null, keywordSeverity: null, minutesSinceReclaimOpen: -1 };
const s = (o) => R.score({ ...base, ...o });

// Nothing flagged, nothing fires.
assert.equal(s({}).score, 0);

// Trigger site (30) + full duration (30) = 60 = default medium threshold -> triggers.
let r = s({ domain: "www.youtube.com".replace("www.", ""), sessionMinutes: 15 });
assert.equal(r.score, 60); assert.ok(r.triggers); assert.ok(!r.isHighRisk);
// Subdomains of trigger sites match.
assert.ok(s({ domain: "old.reddit.com" }).factors.includes("triggerApp"));
// Look-alike domains don't.
assert.ok(!s({ domain: "notreddit.com" }).factors.includes("triggerApp"));

// Duration is gradual and capped.
assert.equal(s({ sessionMinutes: 5 }).score, 10);
assert.equal(s({ sessionMinutes: 500 }).score, 30);

// Intensity changes the threshold: same score, different outcome.
assert.equal(s({ context: { intensity: "low" } }).threshold, 90);
assert.equal(s({ context: { intensity: "high" } }).threshold, 35);

// Convergence: 3 factors +15, 4 factors +30.
r = s({ domain: "reddit.com", sessionMinutes: 15, hour: 23,
  context: { temptingTimes: ["Night"], riskyTimeBuckets: ["Night"], commonTriggers: ["Social media"] } });
assert.deepEqual(r.factors.sort(), ["duration","historicalTime","selfReportedTime","socialMedia","triggerApp"].sort());
assert.equal(r.score, 30 + 30 + 20 + 15 + 10 + 30);

// Keyword tiers: only the highest tier counts (never stacked), each scaled by intensity.
assert.equal(s({ keywordSeverity: "moderate" }).score, 40);
assert.equal(s({ keywordSeverity: "mild" }).score, 15);
assert.equal(s({ keywordSeverity: "severe" }).score, 150);
assert.equal(s({ keywordSeverity: "moderate", context: { intensity: "low" } }).score, 32);
assert.equal(s({ keywordSeverity: "moderate", context: { intensity: "high" } }).score, 48);
assert.ok(s({ keywordSeverity: "moderate" }).factors.includes("recentKeyword"));
assert.ok(s({ keywordSeverity: "mild" }).factors.includes("recentKeywordMild"));
// Severe ALWAYS notifies and is high risk, at every intensity -- even at Low's 90/110 bar...
for (const intensity of ["low", "medium", "high"]) {
  r = s({ keywordSeverity: "severe", context: { intensity } });
  assert.ok(r.triggers && r.isHighRisk && r.severe, intensity);
}
// ...though recently opening Reclaim can soften (not erase) it, as on Android.
assert.equal(s({ keywordSeverity: "severe", minutesSinceReclaimOpen: 5 }).score, 125);
// A lone moderate keyword at Medium doesn't notify (40 < 60); it needs company.
assert.ok(!s({ keywordSeverity: "moderate" }).triggers);
assert.ok(s({ keywordSeverity: "moderate", domain: "reddit.com" }).triggers);
// Severity lookup: per-tier windows (severe 30m, moderate 15m, mild 10m), scoped to the site,
// highest tier wins, unknown words ignored.
const now = Date.now(), ago = (m) => now - m * 60000;
assert.equal(R.mostSevereRecentKeyword([{ domain: "a.com", keyword: "pornhub", at: ago(25) }], "a.com", now), "severe");
assert.equal(R.mostSevereRecentKeyword([{ domain: "a.com", keyword: "pornhub", at: ago(31) }], "a.com", now), null);
assert.equal(R.mostSevereRecentKeyword([{ domain: "a.com", keyword: "nsfw", at: ago(16) }], "a.com", now), null);
assert.equal(R.mostSevereRecentKeyword([{ domain: "a.com", keyword: "naked", at: ago(11) }], "a.com", now), null);
assert.equal(R.mostSevereRecentKeyword([{ domain: "b.com", keyword: "pornhub", at: ago(1) }], "a.com", now), null);
assert.equal(R.mostSevereRecentKeyword([
  { domain: "a.com", keyword: "naked", at: ago(1) }, { domain: "a.com", keyword: "nsfw", at: ago(1) },
  { domain: "a.com", keyword: "bogus", at: ago(1) }], "a.com", now), "moderate");

// Protective: recently opening Reclaim subtracts, floor 0.
assert.equal(s({ domain: "reddit.com", minutesSinceReclaimOpen: 5 }).score, 5);
assert.equal(s({ minutesSinceReclaimOpen: 5 }).score, 0);

// High-risk margin is +20 over the user's own threshold.
assert.ok(s({ domain: "reddit.com", sessionMinutes: 15, hour: 23, context: { temptingTimes: ["Night"] } }).isHighRisk);

// Time buckets match constants.js / RiskProfile.
assert.deepEqual([4,5,11,12,16,17,21,22].map(R.timeBucket), ["Night","Morning","Morning","Afternoon","Afternoon","Evening","Evening","Night"]);

// Adaptive weights: +/-2, clamped, unknown ignored, tags dedupe.
let w = R.adjustWeights(null, ["triggerApp", "bogus"], true);
assert.equal(w.triggerApp, 32);
for (let i = 0; i < 50; i++) w = R.adjustWeights(w, ["triggerApp"], true);
assert.equal(w.triggerApp, 45);
for (let i = 0; i < 50; i++) w = R.adjustWeights(w, ["triggerApp"], false);
assert.equal(w.triggerApp, 15);
assert.deepEqual(R.factorsForTags(["Fatigue", "Late at night", "Anger or frustration"]).sort(), ["historicalTime","selfReportedTime"]);
// Tuned weights change the score.
assert.equal(s({ domain: "reddit.com", storedWeights: { triggerApp: 45 } }).score, 45);

// Keywords: whole words only; hostnames work; plain text doesn't match substrings.
assert.deepEqual(Shared.findKeywords("Visit pornhub.com now").map(k=>k.keyword), ["pornhub"]);
assert.deepEqual(Shared.findKeywords("a Ford Escort ad").map(k=>k.keyword), ["escort"]); // whole word: still matches
assert.deepEqual(Shared.findKeywords("denuded landscape, nudged along"), []);
assert.deepEqual(Shared.findKeywords("pornhub com".replace(/\./g," ")).map(k=>k.keyword), ["pornhub"]);
assert.ok(Shared.domainMatches("mail.google.com", Shared.SENSITIVE_DOMAINS));
assert.ok(Shared.isAppUrl("https://reclaim128.org/x") && !Shared.isAppUrl("https://reclaim128.org.evil.com/"));
// Tier data: every keyword is in exactly one tier; spot-check the placements against Android's.
const sev = (k) => Shared.KEYWORD_SEVERITY[k];
for (const k of ["pornhub", "xvideos", "onlyfans", "brazzers", "free porn", "porn videos", "hire an escort", "escort service"]) assert.equal(sev(k), "severe", k);
for (const k of ["porn", "xxx", "nsfw", "nudes", "hentai", "erotic", "fetish", "sexting", "strip club", "escort", "milf", "blowjob"]) assert.equal(sev(k), "moderate", k);
for (const k of ["nude", "18+", "sexy pics", "thirst trap", "hardcore", "naked", "masturbation", "cam site"]) assert.equal(sev(k), "mild", k);
const flat = Object.keys(Shared.KEYWORDS);
assert.equal(flat.length, new Set(flat).size);
assert.ok(flat.length >= 100, "list size " + flat.length);
// Whole-word/phrase matching, in text and hostnames, including the web-only words.
for (const [text, kw] of [["best brazzers videos", "brazzers"], ["xnxx com", "xnxx"], ["a milf site", "milf"], ["cam girls online", "cam girls"], ["rule34 art", "rule34"], ["18+ only", "18+"], ["watch porn now", "watch porn"]]) {
  assert.ok(Shared.findKeywords(text).some((k) => k.keyword === kw), kw);
}
assert.deepEqual(Shared.findKeywords("normal text about milfoil, Georgy and Jerome"), []);
assert.deepEqual(Shared.findKeywords("hardwood floors"), []);
console.log("all extension tests passed");
