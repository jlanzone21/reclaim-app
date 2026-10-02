// Run: node extension/tests/riskScorer.test.js
const assert = require("node:assert/strict");
const Shared = require("../lib/shared.js");
globalThis.ReclaimShared = Shared;
const R = require("../lib/riskScorer.js");

const base = { domain: "example.com", sessionMinutes: 0, hour: 14, triggerDomains: Shared.DEFAULT_TRIGGER_DOMAINS,
  context: {}, storedWeights: null, minutesSinceKeyword: -1, minutesSinceReclaimOpen: -1 };
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

// Keyword evidence is recent-only.
assert.ok(s({ minutesSinceKeyword: 10 }).factors.includes("recentKeyword"));
assert.ok(!s({ minutesSinceKeyword: 16 }).factors.includes("recentKeyword"));

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
// Explicit keyword floor: high risk immediately at ANY intensity, even right after opening Reclaim.
for (const intensity of ["low", "medium", "high"]) {
  r = s({ context: { intensity }, strongKeywordRecent: true, minutesSinceReclaimOpen: 1 });
  assert.ok(r.triggers && r.isHighRisk && r.strong, intensity);
  assert.equal(r.score, r.threshold + 20);
  assert.ok(r.factors.includes("explicitKeyword"));
}
// ...but never lowers a score that is already higher, and not set without the flag.
assert.equal(s({ domain: "reddit.com", sessionMinutes: 15, hour: 23, strongKeywordRecent: true,
  context: { temptingTimes: ["Night"], riskyTimeBuckets: ["Night"], commonTriggers: ["Social media"] } }).score, 135);
assert.ok(!s({ minutesSinceKeyword: 5 }).strong);
// Only the unambiguous words are strong.
for (const k of ["porn", "pornhub", "onlyfans", "xxx"]) assert.ok(Shared.STRONG_KEYWORDS.includes(k), k);
for (const k of ["nsfw", "nude", "erotic", "escort", "fetish"]) assert.ok(!Shared.STRONG_KEYWORDS.includes(k), k);
assert.ok(Shared.STRONG_KEYWORDS.every((k) => k in Shared.KEYWORDS));
// Expanded keyword list: new terms and site names match as whole words, in text and hostnames.
for (const [text, kw] of [["best brazzers videos", "brazzers"], ["xnxx com", "xnxx"], ["a milf site", "milf"], ["cam girls online", "cam girls"], ["rule34 art", "rule34"], ["leaked nudes thread", "leaked nudes"]]) {
  assert.ok(Shared.findKeywords(text).some((k) => k.keyword === kw), kw);
}
// Ordinary words around them don't match.
assert.deepEqual(Shared.findKeywords("hardcore fans of the hardwood; an ambrosial orgone"), [{ keyword: "hardcore", category: "explicit_content" }].slice(0, 1));
assert.deepEqual(Shared.findKeywords("normal text about milfoil and cumulus clouds"), []);
assert.ok(Shared.STRONG_KEYWORDS.includes("brazzers") && !Shared.STRONG_KEYWORDS.includes("hardcore") && !Shared.STRONG_KEYWORDS.includes("naked"));
console.log("all extension tests passed");
