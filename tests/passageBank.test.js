// Run: node tests/passageBank.test.js
// Loads the real web/js/passageBank.js in a vm with stubs for the embedding model (hand-made vectors on three
// "meaning" axes: loneliness / temptation / anxiety), the daily passages, check-ins, the daily schedule and the
// native bridge, and checks how the passage a risk nudge offers to pray through is ranked: by meaning for the
// situation and the person's recent struggles (Joey's method, carried over from VerseBank), shifted by what
// helped under similar conditions, and handed to the notifiers as a plan.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const plain = (x) => JSON.parse(JSON.stringify(x));
const deepEqual = (a, b, msg) => assert.deepEqual(plain(a), plain(b), msg);
const src = fs.readFileSync(path.join(__dirname, "..", "web", "js", "passageBank.js"), "utf8");

// Daily passages (reference, description) and where their descriptions sit on the three axes.
const PASSAGES = [
  { reference: "Psalm 68:5-6", description: "God sets the lonely in families.", vec: [1, 0, 0.1] },
  { reference: "Psalm 23:1-6", description: "The Lord is my shepherd, with me in the darkest valley.", vec: [0.9, 0.1, 0.3] },
  { reference: "1 Corinthians 10:12-13", description: "God provides a way out of every temptation.", vec: [0, 1, 0.1] },
  { reference: "Matthew 26:40-41", description: "Watch and pray so you will not fall into temptation.", vec: [0.1, 0.9, 0.2] },
  { reference: "Philippians 4:6-7", description: "Bring every anxious thought to God in prayer.", vec: [0.2, 0.2, 1] },
  { reference: "Isaiah 41:10", description: "Do not fear, for I am with you.", vec: [0.3, 0.1, 0.9] },
];

function load({ embedder = true, android = true, extension = false, checkins, outcomes, passages = PASSAGES } = {}) {
  const calls = { sync: 0, ensured: [], analyzed: [] };
  const store = {};
  if (outcomes) store.reclaim_passage_outcomes_v1 = JSON.stringify(outcomes);
  let embedderReady = embedder;
  const norm = (v) => { const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };
  const vectors = new Map();
  const sandbox = {
    console: { log: console.log, warn() {}, error: console.error },
    Date, Math, JSON, Promise, Set, Map, Array, Object, String, Number, RegExp,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => (store[k] = String(v)) },
    DAILY_PASSAGES: passages.map(({ reference, description }) => ({ reference, description })),
    ResourceFeedback: { weightedRows: () => [] },
    LocalEmbedder: {
      isReady: () => embedderReady,
      // a passage's vector exists only once it has been embedded (ensureItems)
      ensureItems: async (items) => {
        calls.ensured.push(...items.map((it) => it.key));
        for (const it of items) {
          const p = passages.find((x) => `passage:${x.reference}` === it.key);
          if (p) vectors.set(it.key, norm(p.vec));
        }
        return true;
      },
      vectorFor: (key) => vectors.get(key) || null,
      cosine: (a, b) => a.reduce((s, x, i) => s + x * b[i], 0),
      tasteVector: () => null,
      // the "meaning" of a situation sentence: which axis its words point at
      analyze: async (text) => {
        calls.analyzed.push(text);
        const t = text.toLowerCase();
        const v = [/alone|lonel/.test(t) ? 1 : 0, /temptation/.test(t) ? 1 : 0, /anxi|stress/.test(t) ? 1 : 0.05];
        return { queryVec: norm(v) };
      },
    },
    CheckInStore: { list: () => checkins || [{ timestamp: new Date().toISOString(), type: "slipped", tags: ["Loneliness", "Stress"] }] },
    UserPreferencesStore: { get: () => ({ common_triggers: ["Boredom"] }) },
    RiskProfile: { syncToNative: () => calls.sync++ },
    LocalSignals: { available: () => android },
    WebTracker: { available: () => extension },
    DailyPassage: {
      dayNumber: () => 20000,
      schedule: () => [{ day: 20000, ref: "Isaiah 41:10" }, { day: 20001, ref: "Psalm 23:1-6" }],
      usedToday: () => ["Philippians 4:6-7"],
    },
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(src + "\n;this.PassageBank = PassageBank;", ctx, { filename: "passageBank.js" });
  return { P: sandbox.PassageBank, calls, store, setEmbedder: (on) => (embedderReady = on) };
}

(async () => {
  // ---- the situation sentence carries the time and the reasons; the person's struggles are scored apart ----
  const { P } = load();
  const ctx = P._recentContext();
  deepEqual(ctx.tags, ["loneliness", "stress", "boredom"], "recent check-in tags first (slips weigh double), then triggers named at setup");
  const s = P._situationText("DTL", "Night");
  assert.match(s, /late at night/);
  assert.match(s, /long while/);
  assert.match(s, /hard time of day/);
  assert.match(s, /alone with no one nearby/);
  assert.ok(!/struggled/.test(s));
  assert.match(P._contextText(ctx), /struggled with loneliness, stress, boredom/);
  assert.equal(P._contextText({ tags: [] }), null);
  assert.match(P._situationText("K", "Morning"), /in the morning[\s\S]*moment of temptation/);

  // ---- refresh: 36 situations, each a ranked list of daily passages, by meaning ----
  let t = load();
  assert.equal(await t.P.refresh(), true);
  assert.ok(PASSAGES.every((p) => t.calls.ensured.includes(`passage:${p.reference}`)), "every passage is embedded under its own key");
  const plan = t.P.getPlan();
  assert.equal(Object.keys(plan.ranked).length, 9 * 4);
  for (const list of Object.values(plan.ranked)) assert.equal(list.length, PASSAGES.length, "ranked lists cover the passages (capped at 8)");
  // alone (L) at night -> the loneliness passages first
  assert.ok(["Psalm 68:5-6", "Psalm 23:1-6"].includes(plan.ranked["DL|Night"][0]), plan.ranked["DL|Night"][0]);
  // someone with no recorded struggles gets the temptation passages for a temptation moment (pure meaning)
  const plainPerson = load({ checkins: [] });
  await plainPerson.P.refresh();
  assert.ok(["1 Corinthians 10:12-13", "Matthew 26:40-41"].includes(plainPerson.P.getPlan().ranked["K|Night"][0]));
  assert.equal(t.calls.sync, 1, "mirrored to the notifiers");
  // fresh ranking isn't rebuilt; forcing does; a changed passage list does
  assert.equal(await t.P.refresh(), false);
  assert.equal(await t.P.refresh({ force: true }), true);

  // ---- the plan: descriptions, schedule, ranking, and what was already prayed through today ----
  deepEqual(Object.keys(plan.passages), PASSAGES.map((p) => p.reference));
  assert.equal(plan.passages["Isaiah 41:10"], "Do not fear, for I am with you.");
  deepEqual(plan.schedule[0], { day: 20000, ref: "Isaiah 41:10" });
  deepEqual(plan.used, { day: 20000, refs: ["Philippians 4:6-7"] });
  // a ranking stored for passages no longer in the list keeps only the ones that still are
  t.store.reclaim_passage_bank_v1 = JSON.stringify({ at: Date.now(), n: 6, ranked: { "K|Night": ["Gone 1:1", "Isaiah 41:10"], "A|Night": "not a list" } });
  deepEqual(t.P.getPlan().ranked, { "K|Night": ["Isaiah 41:10"] });

  // ---- only where something posts nudges, and only with the embedding model ----
  assert.equal(await load({ android: false }).P.refresh({ force: true }), false, "no notifier: nothing to build for");
  assert.equal(await load({ android: false, extension: true }).P.refresh({ force: true }), true, "the browser extension counts");
  t = load({ embedder: false });
  assert.equal(await t.P.refresh({ force: true }), false, "no embedding model: no ranking (notifiers fall back to the schedule)");
  deepEqual(t.P.getPlan().ranked, {});
  assert.equal(t.P.getPlan().schedule.length, 2, "...but the plan still carries the schedule");
  t.setEmbedder(true);
  assert.equal(await t.P.refresh(), true, "built once the model is ready");

  // ---- hubness: a passage moderately close to EVERYTHING must not win by default ----
  {
    const h = load({});
    await h.P.refresh();
    const cands = PASSAGES.filter((p) => ["Psalm 68:5-6", "Psalm 23:1-6", "Isaiah 41:10"].includes(p.reference)).map((p) => ({ ref: p.reference, description: p.description }));
    const lonely = [1, 0, 0.05].map((x) => x / Math.hypot(1, 0, 0.05));
    const noHub = h.P._rank(cands, "DL", "Night", lonely, {}, {}, [], Date.now(), {}).map((r) => r.c.ref);
    assert.equal(noHub[0], "Psalm 68:5-6");
    // Psalm 68 is close to every situation on average, and barely varies: corrected, it no longer leads
    const hub = { "Psalm 68:5-6": { mean: 0.95, sd: 0.05 }, "Psalm 23:1-6": { mean: 0.5, sd: 0.2 }, "Isaiah 41:10": { mean: 0.3, sd: 0.2 } };
    const withHub = h.P._rank(cands, "DL", "Night", lonely, {}, {}, [], Date.now(), hub).map((r) => r.c.ref);
    assert.notEqual(withHub[0], "Psalm 68:5-6", "a hub passage no longer wins by default");
    // mean and spread over the situation queries define the hub
    const scores = h.P._hubScores(cands, [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
    assert.ok(scores["Isaiah 41:10"].mean > 0 && scores["Isaiah 41:10"].sd > 0 && Object.keys(scores).length === 3);
    // the person's struggles / taste count as z-scores across the passages: the closest scores highest, mean 0
    const z = h.P._standardized(cands, lonely);
    assert.ok(z["Psalm 68:5-6"] > z["Psalm 23:1-6"] && z["Psalm 23:1-6"] > z["Isaiah 41:10"]);
    assert.ok(Math.abs(Object.values(z).reduce((a, b) => a + b, 0)) < 1e-9);
    deepEqual(h.P._standardized(cands, null), {});
  }

  // ---- experience: "This helped" / "Not for me" on the closing screen moves the ranking for that situation ----
  const at = Date.now();
  const topFor = async (opts, key) => { const x = load(opts); await x.P.refresh({ force: true }); return x.P.getPlan().ranked[key]; };
  const base = await topFor({}, "DL|Night");
  const first = base[0];
  const downed = await topFor({ outcomes: [{ at, ref: first, sig: "DL", bucket: "Night", rating: -1 }] }, "DL|Night");
  assert.notEqual(downed[0], first, "a 'not for me' under these conditions demotes the passage");
  const second = base[1];
  const upped = await topFor({ outcomes: [1, 2, 3].map(() => ({ at, ref: second, sig: "DL", bucket: "Night", rating: 1 })) }, "DL|Night");
  assert.equal(upped[0], second, "repeated 'this helped' under these conditions promotes a passage");
  assert.ok(Math.abs(P._outcomeScore("A", "DL", "Night", [{ at: at - 90 * 86400000, ref: "A", sig: "DL", bucket: "Night", rating: 1 }], at) - 0.5) < 0.01, "90-day half-life");
  const mk = (sig, bucket) => P._outcomeScore("A", "DL", "Night", [{ at, ref: "A", sig, bucket, rating: 1 }], at);
  assert.ok(mk("DL", "Night") > mk("DL", "Morning") && mk("DL", "Morning") > mk("K", "Night"));
  // recordOutcome: a meditation from Home has no situation and counts a quarter everywhere
  t = load();
  t.P.recordOutcome({ ref: "Isaiah 41:10", rating: 1 });
  t.P.recordOutcome({ ref: "Psalm 23:1-6", sig: "K", bucket: "Night", rating: -5 });
  deepEqual(t.P._readOutcomes().map((o) => [o.ref, o.sig, o.bucket, o.rating]), [["Isaiah 41:10", "", "", 1], ["Psalm 23:1-6", "K", "Night", -1]]);
  assert.equal(P._outcomeScore("Isaiah 41:10", "K", "Night", [{ at, ref: "Isaiah 41:10", sig: "", bucket: "", rating: 1 }], at), 0.25);

  console.log("passage bank tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
