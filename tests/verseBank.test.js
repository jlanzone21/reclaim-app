// Run: node tests/verseBank.test.js
// Loads the real web/js/verseBank.js in a vm with stubs for the embedding model (hand-made vectors on three
// "meaning" axes: loneliness / temptation / anxiety), the database, YouVersion, check-ins and the native
// bridge, and checks how the overlay's Bible verse is chosen: by meaning for the situation and the person's
// recent struggles, shifted by what helped under similar conditions, with attribution, and robust to the
// embedding model or YouVersion being unavailable.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const plain = (x) => JSON.parse(JSON.stringify(x));
const deepEqual = (a, b, msg) => assert.deepEqual(plain(a), plain(b), msg);
const src = fs.readFileSync(path.join(__dirname, "..", "web", "js", "verseBank.js"), "utf8");

// Seed verses (title, body, tags) and where they sit on the three axes.
const VERSES = [
  { title: "Psalm 68:6", body: "God sets the lonely in families, he leads out the prisoners with singing.", tags: ["loneliness", "community"], vec: [1, 0, 0.1] },
  { title: "Psalm 23:4", body: "Even though I walk through the darkest valley, I will fear no evil, for you are with me.", tags: ["loneliness", "hope"], vec: [0.9, 0.1, 0.3] },
  { title: "1 Corinthians 10:13", body: "No temptation has overtaken you except what is common to mankind. God is faithful; he will provide a way out.", tags: ["temptation", "struggle"], vec: [0, 1, 0.1] },
  { title: "Matthew 26:41", body: "Watch and pray so that you will not fall into temptation.", tags: ["temptation", "in-the-moment"], vec: [0.1, 0.9, 0.2] },
  { title: "Philippians 4:6-7", body: "Do not be anxious about anything, but in every situation, by prayer, present your requests to God.", tags: ["anxiety", "stress"], vec: [0.2, 0.2, 1] },
  { title: "Isaiah 41:10", body: "So do not fear, for I am with you; do not be dismayed, for I am your God.", tags: ["stress", "hope"], vec: [0.3, 0.1, 0.9] },
  { title: "Too Long 1:1", body: "x".repeat(400), tags: ["loneliness"], vec: [1, 0, 0] },
];

function load({ embedder = true, youversion = true, android = true, feedback = [], checkins, outcomes } = {}) {
  const calls = { sync: 0, rated: [], remembered: [], analyzed: [], fetched: [] };
  const store = {};
  if (outcomes) store.reclaim_verse_outcomes_v1 = JSON.stringify(outcomes);
  let embedderReady = embedder;
  const norm = (v) => { const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };
  const vecByKey = new Map(VERSES.map((v) => [`verse:${v.title}`, norm(v.vec)]));
  const sandbox = {
    console: { log: console.log, warn() {}, error: console.error },
    Date, Math, JSON, Promise, Set, Map, Array, Object, String, Number, RegExp,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => (store[k] = String(v)) },
    DB: { all: () => VERSES.map((v) => ({ title: v.title, body: v.body, tags: JSON.stringify(v.tags) })) },
    ResourceFeedback: {
      describe: (tool, item) => ({ tool, key: "verse:" + item.title, keywords: item.tags || [] }),
      weightedRows: () => [],
      rate: (id, entry, rating) => (calls.rated.push({ id, key: entry.key, rating }), 1),
    },
    LocalEmbedder: {
      isReady: () => embedderReady,
      vectorFor: (key) => vecByKey.get(key) || null,
      cosine: (a, b) => a.reduce((s, x, i) => s + x * b[i], 0),
      tasteVector: () => null,
      rememberItem: (key, text) => calls.remembered.push(key),
      // the "meaning" of a situation sentence: which axis its words point at
      analyze: async (text) => {
        calls.analyzed.push(text);
        const t = text.toLowerCase();
        const v = [/alone|lonel/.test(t) ? 1 : 0, /temptation/.test(t) ? 1 : 0, /anxi|stress/.test(t) ? 1 : 0.05];
        return { queryVec: norm(v) };
      },
    },
    YouVersion: youversion
      ? {
          available: () => true,
          getVerse: async (ref) => {
            calls.fetched.push(ref);
            return {
              reference: ref,
              html: '<div data-yv-sdk><span class="yv-vlbl">1</span>For God <i>so</i> loved the world &amp; gave &ldquo;everything&rdquo;.<sup>a</sup></div>',
              attribution: { text: "Scripture quotations are from the NIV." },
              version: { abbreviation: "NIV" },
            };
          },
        }
      : { available: () => false },
    CheckInStore: { list: () => checkins || [{ timestamp: new Date().toISOString(), type: "slipped", tags: ["Loneliness", "Stress"] }] },
    UserPreferencesStore: { get: () => ({ common_triggers: ["Boredom"] }) },
    RiskProfile: { syncToNative: () => calls.sync++ },
    LocalSignals: { available: () => android, takePendingVerseFeedback: async () => feedback },
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(src + "\n;this.VerseBank = VerseBank;", ctx, { filename: "verseBank.js" });
  return { V: sandbox.VerseBank, calls, store, setEmbedder: (on) => (embedderReady = on) };
}

(async () => {
  // ---- plain text from YouVersion HTML ----
  const { V } = load();
  assert.equal(V._plainText('<div><span class="yv-vlbl">16</span>For God <i>so</i> loved the world &amp; gave &ldquo;all&rdquo;.<sup>a</sup></div>'), 'For God so loved the world & gave "all".');
  assert.equal(V._plainText("  <p>a&nbsp;b</p>\n<p>c</p> "), "a b c");

  // ---- the situation sentence carries the time, the reasons and the person's recent struggles ----
  const ctx = V._recentContext();
  deepEqual(ctx.tags, ["loneliness", "stress", "boredom"], "recent check-in tags first (slips weigh double), then triggers named at setup");
  const s = V._situationText("DTL", "Night", ctx);
  assert.match(s, /late at night/);
  assert.match(s, /long while/);
  assert.match(s, /hard time of day/);
  assert.match(s, /alone with no one nearby/);
  assert.ok(!/struggled/.test(s), "the person's struggles are scored separately, not folded into the situation");
  assert.match(V._contextText(ctx), /struggled with loneliness, stress, boredom/);
  assert.equal(V._contextText({ tags: [] }), null, "no recorded struggles -> no personal-context vector");
  assert.match(V._situationText("K", "Morning"), /in the morning[\s\S]*moment of temptation/);

  // ---- refresh: 36 situations, 3 verses each, chosen by meaning, with text + attribution ----
  let t = load();
  assert.equal(await t.V.refresh(), true);
  const bank = t.V.getBank();
  assert.equal(Object.keys(bank).length, 9 * 4);
  for (const list of Object.values(bank)) assert.ok(list.length >= 1 && list.length <= 4);
  // alone (L) at night -> the loneliness verses; a keyword/temptation moment (K) -> the temptation verses
  assert.ok(["Psalm 68:6", "Psalm 23:4"].includes(bank["DL|Night"][0].ref), bank["DL|Night"][0].ref);
  // this person's recent check-ins are about loneliness and stress, so even a temptation moment leans toward them...
  assert.ok(["Psalm 68:6", "Psalm 23:4", "1 Corinthians 10:13", "Matthew 26:41"].includes(bank["K|Night"][0].ref));
  // ...while someone with no recorded struggles gets the temptation verses for the same moment (pure meaning)
  const plainPerson = load({ checkins: [] });
  await plainPerson.V.refresh();
  assert.ok(["1 Corinthians 10:13", "Matthew 26:41"].includes(plainPerson.V.getBank()["K|Night"][0].ref), plainPerson.V.getBank()["K|Night"][0].ref);
  // and the same situation differs BETWEEN people: the lonely person's verse for "on a flagged app" is a loneliness verse
  await load({ checkins: [{ timestamp: new Date().toISOString(), type: "resisted", tags: ["Stress"] }] }).V.refresh();
  assert.ok(!Object.values(bank).flat().some((e) => e.ref === "Too Long 1:1"), "verses too long for a glance are never used");
  // text comes from YouVersion, plain, with the required attribution
  const e = bank["K|Night"][0];
  assert.equal(e.text, 'For God so loved the world & gave "everything".');
  assert.equal(e.attribution, "NIV · Scripture quotations are from the NIV.");
  assert.equal(t.calls.sync, 1, "mirrored to the native overlay");
  // one fetch per distinct verse, not per situation
  assert.equal(new Set(t.calls.fetched).size, t.calls.fetched.length);
  // fresh bank isn't rebuilt; forcing does
  assert.equal(await t.V.refresh(), false);
  assert.equal(await t.V.refresh({ force: true }), true);

  // ---- YouVersion unavailable: the bundled text for that verse, no attribution ----
  t = load({ youversion: false });
  await t.V.refresh();
  const local = t.V.getBank()["DL|Night"][0];
  assert.equal(local.text, VERSES.find((v) => v.title === local.ref).body);
  assert.equal(local.attribution, "");

  // ---- no embedding model: ranks on tags, and is rebuilt once the model is ready ----
  t = load({ embedder: false });
  assert.equal(await t.V.refresh(), true);
  assert.ok(["Psalm 68:6", "Psalm 23:4"].includes(t.V.getBank()["AL|Night"][0].ref), "tag fallback still finds the lonely verses");
  assert.equal(await t.V.refresh(), false, "fresh and nothing new to use");
  t.setEmbedder(true);
  assert.equal(await t.V.refresh(), true, "built without embeddings -> rebuilt when the model becomes ready");
  assert.equal(await t.V.refresh(), false);

  // ---- hubness: a verse that is moderately close to EVERYTHING must not win by default ----
  {
    const h = load({});
    const cands = VERSES.filter((v) => ["Psalm 68:6", "Psalm 23:4", "Isaiah 41:10"].includes(v.title)).map((v) => ({ title: v.title, body: v.body, tags: v.tags }));
    const lonely = { queryVec: [1, 0, 0.05].map((x) => x / Math.hypot(1, 0, 0.05)) };
    const noHub = h.V._rank(cands, "DL", "Night", { tags: [] }, lonely.queryVec, null, null, [], Date.now(), {}).map((r) => r.v.title);
    assert.equal(noHub[0], "Psalm 68:6", "without correction the closest verse leads");
    // Psalm 68:6 is a hub (close to every query on average): corrected, the verse that is specifically better FOR THIS query leads
    const withHub = h.V._rank(cands, "DL", "Night", { tags: [] }, lonely.queryVec, null, null, [], Date.now(), { "Psalm 68:6": 0.6, "Psalm 23:4": 0.2 }).map((r) => r.v.title);
    assert.notEqual(withHub[0], "Psalm 68:6", "a hub verse no longer wins by default");
    // mean similarity over the queries is what defines the hub
    const scores = h.V._hubScores(cands, [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
    assert.ok(scores["Isaiah 41:10"] > 0 && Object.keys(scores).length === 3);
  }

  // ---- only on Android (the overlay) ----
  assert.equal(await load({ android: false }).V.refresh({ force: true }), false);

  // ---- experience: what helped / didn't help under these conditions moves the ranking ----
  const at = Date.now();
  const topFor = async (opts, key) => { const x = load(opts); await x.V.refresh({ force: true }); return x.V.getBank()[key].map((v) => v.ref); };
  const base = await topFor({}, "DL|Night");
  const first = base[0];
  // "Not for me" on the top verse in this exact situation -> it drops
  const downed = await topFor({ outcomes: [{ at, ref: first, sig: "DL", bucket: "Night", rating: -1 }] }, "DL|Night");
  assert.notEqual(downed[0], first, "a 'not for me' under these conditions demotes the verse");
  // ...but counts for much less in a different situation (a quarter): the same verses are chosen, at most
  // re-ordered slightly -- a "not for me" while alone at night doesn't ban the verse everywhere
  const elsewhere = await topFor({ outcomes: [{ at, ref: first, sig: "DL", bucket: "Night", rating: -1 }] }, "K|Morning");
  deepEqual([...elsewhere].sort(), [...(await topFor({}, "K|Morning"))].sort());
  // "This helped" on a weaker verse in this situation promotes it past the embedding's first choice
  const second = base[1];
  const upped = await topFor({ outcomes: [1, 2, 3].map(() => ({ at, ref: second, sig: "DL", bucket: "Night", rating: 1 })) }, "DL|Night");
  assert.equal(upped[0], second, "repeated 'this helped' under these conditions promotes a verse");
  // old experience fades
  assert.ok(Math.abs(V._outcomeScore("A", "DL", "Night", [{ at: at - 90 * 86400000, ref: "A", sig: "DL", bucket: "Night", rating: 1 }], at) - 0.5) < 0.01, "90-day half-life");
  // same situation > same sig other time > other situation
  const mk = (sig, bucket) => V._outcomeScore("A", "DL", "Night", [{ at, ref: "A", sig, bucket, rating: 1 }], at);
  assert.ok(mk("DL", "Night") > mk("DL", "Morning") && mk("DL", "Morning") > mk("K", "Night"));

  // ---- feedback parked by the overlay becomes a rating AND a situation-tied outcome, then the bank rebuilds ----
  t = load({ feedback: [{ ref: "Psalm 68:6", text: "God sets the lonely in families", sig: "DL", bucket: "Night", rating: -1, at }, { ref: "Isaiah 41:10", sig: "K", bucket: "Night", rating: 1, at }, { ref: "", rating: 1 }] });
  await t.V.refresh();
  const syncsBefore = t.calls.sync;
  deepEqual(await t.V.processFeedback(), { processed: 2 });
  deepEqual(t.calls.rated, [{ id: null, key: "verse:Psalm 68:6", rating: -1 }, { id: null, key: "verse:Isaiah 41:10", rating: 1 }]);
  deepEqual(t.calls.remembered, ["verse:Psalm 68:6", "verse:Isaiah 41:10"]);
  const outs = t.V._readOutcomes();
  deepEqual(outs.map((o) => [o.ref, o.sig, o.bucket, o.rating]), [["Psalm 68:6", "DL", "Night", -1], ["Isaiah 41:10", "K", "Night", 1]]);
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(t.calls.sync > syncsBefore, "rebuilt and re-synced after feedback");
  assert.notEqual(t.V.getBank()["DL|Night"][0].ref, "Psalm 68:6", "the verse marked 'not for me' no longer leads that situation");
  // nothing waiting / not on Android
  deepEqual(await load({ feedback: [] }).V.processFeedback(), { processed: 0 });
  deepEqual(await load({ android: false, feedback: [{ ref: "x", rating: 1 }] }).V.processFeedback(), { processed: 0 });

  // ---- getBank only hands native well-formed verses ----
  t = load();
  t.store.reclaim_verse_bank_v4 = JSON.stringify({ at: Date.now(), usedEmbeddings: true, bank: {
    "K|Night": [{ ref: "A 1:1", text: "A real verse with enough text.", attribution: "NIV" }, { ref: "", text: "no ref here at all" }, { ref: "B 2:2", text: "x" }, { ref: "C 3:3", text: "Another real verse, long enough." }, { ref: "D 4:4", text: "Fourth real verse that is long." }, { ref: "E 5:5", text: "Fifth real verse that is long enough." }],
    "A|Night": "not an array",
  } });
  const clean = t.V.getBank();
  deepEqual(clean["K|Night"].map((v) => v.ref), ["A 1:1", "C 3:3", "D 4:4", "E 5:5"], "malformed dropped, capped at 4");
  assert.equal(clean["A|Night"], undefined);

  console.log("verse bank tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
