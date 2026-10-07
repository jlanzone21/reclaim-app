/**
 * A small on-device embedding model (snowflake-arctic-embed-s via WebLLM, ~68 MB measured) that
 * turns text into a vector of numbers describing its meaning -- it writes nothing, so it can't
 * invent a verse or advice. Reclaim's AI uses it (resourcePicker.js) to:
 *   1. catch a feeling the keyword lists miss ("everything feels heavy and I want to escape"),
 *   2. catch an ask the keyword lists miss ("anyone I could talk to about this professionally"),
 *   3. rank items within a kind by how close they are in meaning to the message, and
 *   4. rank by "taste": closeness to what the person rated helpful vs not.
 * Never a gate: the crisis check, fixed answers and keyword asks all run first and don't need it.
 *
 * Runs entirely on this device, in its own WebLLM engine (separate from the chat model, so a
 * failure here can never take chat down). It loads after the chat model, under the same AI opt-in
 * (Nathaniel, 2026-10-06: existing AI users get it automatically). If it can't load, everything
 * still works on keywords + thumbs, and the person is told once (app.js).
 *
 * Calibration (2026-10-06, real model in the browser): one description per theme separated
 * feelings from small talk badly ("my day was fine" scored closer to shame than real shame
 * messages). What works: several example messages per class plus a "none" class, the query prefix
 * on both sides, the top-3 average per class, and requiring a margin over "none".
 *
 * Recalibrated 2026-10-07 after fresh everyday small talk got confident false positives ("I just
 * got back from the gym" -> relapse, "my phone battery is low" -> shame): examples are now
 * embedded one at a time (batching shifted results), "none" gained a few targeted everyday lines
 * (EVERYDAY_NONE), the theme bar is 0.035, and good news is never read as a feeling (GOOD_NEWS).
 * Run through this file's own analyze() on every held-out set in scripts/embedding-calibration.js
 * (none of it used as examples): 32/38 real feelings caught (27 the exact theme) with 1/64
 * small-talk lines let through ("my phone battery is low" -> shame); before this change it was
 * 35/38 with 7 of the first 59 let through. Asks: 5/12 caught, 2 wrong kinds. Re-run that script
 * after any change here.
 */
const LocalEmbedder = (function () {
  const MODEL_ID = "snowflake-arctic-embed-s-q0f32-MLC-b4"; // b4: ~240 MB GPU memory; the b32 build needs ~1 GB
  const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
  const THEME_MARGIN = 0.035;
  const ASK_MARGIN = 0.07;
  const GOOD_NEWS = /\b(?:streak|proud|longest|going strong|days? (?:clean|free|strong)|so far so good)\b/i;
  const SETBACK = /\b(?:broke|broken|lost|lose|ended|reset|gone|over|slip\w*|relaps\w*|fail\w*|gave in|caved|messed up)\b/i;
  const FAIL_NOTICE_KEY = "reclaim_embed_fail_notice_shown";
  const IDB_NAME = "reclaim-embeddings";
  const IDB_STORE = "vectors";
  const INDEX_CHUNK = 16;
  const QUERY_TIMEOUT_MS = 2500;

  // Added to both "none" classes after fresh small talk got confident false positives (2026-10-07):
  // "came back from a hike" / "back from church" -> relapse (near "I fell back into it"), "my
  // battery is at 5 percent" -> perseverance, good streak news -> relapse. A broad list of 40
  // everyday lines fixed those but cut real feelings caught from 26/28 to 21/28; these few targeted
  // ones (good news, "back from...", devices) took fresh small-talk false positives from 4/15 to
  // 0/15 at the same 9/10 on fresh real feelings.
  const EVERYDAY_NONE = [
    "I've been clean for a month now", "things are going really well", "I had a good week", "I'm doing better lately",
    "I just got back from work", "we just got back from vacation", "I just came home from practice", "I'm heading to the gym",
    "my car needs gas", "my laptop is about to die", "my streak is going strong", "I'm on a 10 day streak",
  ];

  // Example messages, by theme (AGENT_THEME_WORDS' names) -- the calibrated set. Short, in the
  // person's own voice, deliberately free of the keywords that already catch these.
  const THEME_EXAMPLES = {
    shame: ["I feel so ashamed of myself", "I feel disgusting after what I did", "I can't look at myself in the mirror", "I feel so guilty", "I feel worthless", "I hate who I am when I do this", "I feel dirty", "I'm embarrassed about what I've done"],
    temptation: ["I really want to look at porn right now", "the urge is so strong tonight", "I'm tempted to give in", "I can't stop thinking about watching it", "I'm about to act out", "I'm alone and I want to look", "I keep wanting to open that site", "my mind keeps going back to it"],
    loneliness: ["I feel so alone", "I have no one to talk to", "nobody gets what I'm going through", "I feel isolated from everyone", "I don't have any real friends", "no one would care if I disappeared from their lives", "I'm lonely tonight"],
    anxiety: ["I'm so anxious I can't calm down", "I'm worried about everything", "I'm scared and panicking", "my thoughts won't stop spinning", "I feel on edge all the time", "I can't stop overthinking", "my chest is tight and I'm nervous"],
    stress: ["I'm completely overwhelmed", "there's so much pressure on me", "I'm exhausted and burned out", "life is too much right now", "school is killing me", "I'm drowning in work", "I'm stretched way too thin"],
    hope: ["I feel hopeless", "nothing is ever going to change", "what's the point of even trying", "I've lost all hope", "I'll never beat this", "it feels like there's no way out of this"],
    relapse: ["I slipped up again", "I relapsed today", "I gave in and watched it", "I broke my streak", "I messed up again last night", "I did it again", "I fell back into it", "I lost my streak"],
    grace: ["can God still forgive me", "I don't think God could love me after this", "I need God's mercy", "does grace cover this", "God must be so disappointed in me", "I feel too far gone for God"],
    identity: ["I don't know who I am anymore", "I feel like this defines me", "what am I worth to God", "am I just an addict", "I feel like a fraud as a Christian"],
    freedom: ["I want to be free from this", "I want to quit for good", "I'm tired of being trapped by this", "I want this out of my life", "I'm done letting this control me"],
    perseverance: ["I want to give up", "I don't know if I can keep going", "how do I keep fighting this", "I'm tired of trying so hard", "it's been so long and I'm worn down"],
    community: ["I want to find Christian friends", "I wish I had a church family", "I want people to walk with", "I need guys who get it", "I want to belong somewhere"],
    triggers: ["certain things always set me off", "being bored at night triggers me", "social media makes it worse", "scrolling Instagram gets me every time", "when I'm stressed I want to look"],
    growth: ["I want to grow closer to God", "I want to get serious about my faith", "I want to pray more", "I want to know God better"],
    struggle: ["this is really hard", "I'm struggling today", "today is a battle", "it's a rough day", "I'm having a hard time"],
    none: [...EVERYDAY_NONE, "hi", "hello there", "how are you", "thanks", "ok", "good morning", "what's the weather", "tell me a joke", "what's your name", "who made this app", "is this app private", "how do I change settings", "I had a sandwich for lunch", "my day was fine", "help me with homework", "what can you do", "cool", "bye", "good night", "I'm heading to bed", "lol", "what time is it", "the game was great", "I'm at work", "sounds good", "where do I find my check-ins", "can you remind me later", "I like this app", "what's new", "I'm driving home"],
  };

  // Example asks, by tool. The "none" class includes feelings on purpose: naming a feeling isn't
  // asking for a particular kind of resource (resourcePicker.js handles feelings separately).
  const ASK_EXAMPLES = {
    counseling_directory: ["I want to see a counselor", "can you find me a therapist", "I think I need professional help", "is there a Christian counselor near me", "I want to talk to someone trained in this", "where can I get treatment for this"],
    small_group_finder: ["find me a support group", "are there recovery groups near me", "I want to join a group of guys fighting this", "is there a meeting I can go to", "I want to be around others going through this"],
    sermon_library: ["can I listen to a sermon", "I want to hear a pastor teach on this", "any good messages on purity", "something to listen to about lust"],
    article_finder: ["I want to read about how porn affects the brain", "any articles on this", "can I learn more about addiction", "is there anything to read for my wife"],
    bible_plan_finder: ["give me a bible reading plan", "I want to read the bible every day", "where should I start reading scripture", "a 7 day reading plan"],
    devotional_finder: ["a short devotional please", "something to reflect on this morning", "a reading for my quiet time"],
    scripture_search: ["give me a verse", "what does the bible say about this", "share some scripture", "a psalm for tonight"],
    coping_toolkit: ["what can I do right now to not give in", "help me get through this urge", "I need a distraction", "give me something to do instead", "a breathing exercise"],
    accountability_match: ["I need someone to hold me accountable", "who should I tell about this", "I need someone to check in on me"],
    none: [...EVERYDAY_NONE, "hi", "how are you", "thanks", "ok", "good morning", "tell me a joke", "who made this app", "is this app private", "how do I change settings", "my day was fine", "good night", "I'm at work", "sounds good", "I feel so alone", "I relapsed last night", "I'm so stressed", "I feel ashamed", "I'm struggling today", "I feel hopeless", "I'm anxious", "today was a good day", "I made it another week", "I hate this"],
  };

  // Which resources rows get indexed for ranking, by the tool that shows them.
  const LOCAL_TYPES = { scripture: "scripture_search", devotional: "devotional_finder", coping_mechanism: "coping_toolkit", bible_plan: "bible_plan_finder" };
  const SUPABASE_TYPES = { small_group: "small_group_finder", sermon: "sermon_library", article: "article_finder", counseling_center: "counseling_directory" };

  let state = "off"; // off | loading | ready | failed
  let engine = null;
  let starting = null;
  let themeClasses = null; // { name: [vec, ...] }
  let askClasses = null;
  const vectors = new Map(); // resource key -> { h, v }
  const listeners = new Set();

  function setState(next) {
    state = next;
    listeners.forEach((fn) => fn(state));
  }

  // ---- vector math (the model's vectors aren't unit length, so normalize before cosine) ----

  function normalize(v) {
    let n = 0;
    for (let i = 0; i < v.length; i++) n += v[i] * v[i];
    n = Math.sqrt(n) || 1;
    const out = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
    return out;
  }

  function cosine(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  }

  function hash(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    return (h >>> 0).toString(36);
  }

  // ---- IndexedDB cache: vectors don't change unless the text does, so each is computed once ----
  // Not in the sql.js database on purpose: that's one base64 blob in localStorage (~5 MB cap).

  let idbPromise = null;
  function idb() {
    if (!idbPromise) {
      idbPromise = new Promise((resolve) => {
        try {
          const req = indexedDB.open(IDB_NAME, 1);
          req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        } catch (e) {
          resolve(null);
        }
      });
    }
    return idbPromise;
  }

  async function loadCache() {
    const db = await idb();
    if (!db) return;
    await new Promise((resolve) => {
      const req = db.transaction(IDB_STORE).objectStore(IDB_STORE).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve();
        if (String(cursor.key).startsWith(`${MODEL_ID}|`)) vectors.set(String(cursor.key).slice(MODEL_ID.length + 1), cursor.value);
        cursor.continue();
      };
      req.onerror = () => resolve();
    });
  }

  async function saveVectors(entries) {
    const db = await idb();
    if (!db) return;
    try {
      const store = db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE);
      for (const [key, value] of entries) store.put(value, `${MODEL_ID}|${key}`);
    } catch (e) {}
  }

  async function embedRaw(texts) {
    const res = await engine.embeddings.create({ input: texts });
    return res.data.map((d) => normalize(d.embedding));
  }

  // Embeds whichever of [{ key, text }] aren't cached yet (or whose text changed), a chunk at a
  // time so the page stays responsive. `query` adds the query prefix (example messages). `chunk`:
  // texts per call -- batching pads them to the same length, which shifts the vectors a little.
  async function ensure(items, { query = false, chunk: size = INDEX_CHUNK } = {}) {
    const todo = items.filter((it) => {
      const cached = vectors.get(it.key);
      return !cached || cached.h !== hash(it.text);
    });
    for (let i = 0; i < todo.length; i += size) {
      const chunk = todo.slice(i, i + size);
      const vecs = await embedRaw(chunk.map((it) => (query ? QUERY_PREFIX : "") + it.text));
      const entries = chunk.map((it, j) => [it.key, { h: hash(it.text), v: vecs[j] }]);
      entries.forEach(([k, val]) => vectors.set(k, val));
      await saveVectors(entries);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  // Example messages are embedded one at a time, exactly like a person's message is in analyze():
  // batched (padded) example vectors made the same calibration give different answers -- "who won
  // the game" was a false positive with one batching and not another (2026-10-07). The "ex1:" key
  // prefix retires the batched vectors cached before that. ~200 short texts, once, then cached.
  async function buildClasses(examples, prefix) {
    const key = (label, t) => `ex1:${prefix}:${label}:${t}`;
    const items = [];
    for (const [label, texts] of Object.entries(examples)) texts.forEach((t) => items.push({ key: key(label, t), text: t }));
    await ensure(items, { query: true, chunk: 1 });
    const classes = {};
    for (const [label, texts] of Object.entries(examples)) classes[label] = texts.map((t) => vectors.get(key(label, t)).v);
    return classes;
  }

  // Best non-"none" class and how far its top-3 average similarity beats "none"'s.
  function classify(vec, classes) {
    let best = null;
    let bestScore = -Infinity;
    let none = 0;
    for (const [label, vecs] of Object.entries(classes)) {
      const sims = vecs.map((v) => cosine(vec, v)).sort((a, b) => b - a);
      const k = Math.min(3, sims.length);
      const score = sims.slice(0, k).reduce((a, b) => a + b, 0) / k;
      if (label === "none") none = score;
      else if (score > bestScore) {
        best = label;
        bestScore = score;
      }
    }
    return { label: best, margin: bestScore - none };
  }

  // ---- text for each resource (what gets embedded for ranking and taste) ----

  function itemText(item) {
    return [item.title, item.subtitle, item.body].filter(Boolean).join(". ").slice(0, 600);
  }

  async function indexResources() {
    // Local content: every row of the kinds that get ranked.
    const local = [];
    for (const [type, tool] of Object.entries(LOCAL_TYPES)) {
      for (const row of DB.all("SELECT title, subtitle, body, tags FROM resources WHERE type = ?", [type])) {
        local.push({ key: ResourceFeedback.describe(tool, row).key, text: itemText(row) });
      }
    }
    await ensure(local);
    // Supabase directory content: public data, fetched the same way the app already does.
    for (const [type, tool] of Object.entries(SUPABASE_TYPES)) {
      try {
        const rows = await SupabaseClient.queryResources(type);
        await ensure(rows.map((row) => ({ key: ResourceFeedback.describe(tool, row).key, text: itemText(row) })));
      } catch (e) {
        // Offline: those get indexed next time; ranking just skips meaning for them meanwhile.
      }
    }
  }

  // Called by LocalModel once the chat model is ready, with its WebLLM appConfig (same cache).
  function start(appConfig) {
    if (starting || state === "ready") return starting;
    starting = (async () => {
      setState("loading");
      try {
        await loadCache();
        engine = await webllm.CreateMLCEngine(MODEL_ID, { appConfig });
        // GPU warm-up: the first embed after loading took ~9 s in testing. Done here, always --
        // the example vectors below usually come from the cache and make no GPU call, which in
        // testing left the warm-up to the person's first message (it hit the timeout and lost).
        await embedRaw(["warm up"]);
        themeClasses = await buildClasses(THEME_EXAMPLES, "theme");
        askClasses = await buildClasses(ASK_EXAMPLES, "ask");
        verseTopics = await buildVerseTopics();
        setState("ready");
        indexResources().catch((err) => console.warn("Embedding index incomplete:", err));
      } catch (err) {
        console.warn("Embedding model unavailable; matching uses keywords and thumbs only:", err);
        engine = null;
        setState("failed");
      } finally {
        starting = null;
      }
    })();
    return starting;
  }

  // ---- The 100 verse topics (verse_topics in db.js), matched by meaning ----
  //
  // Replaces the word-overlap matchVerseTopic (agentTools.js) in AI mode, which fired on single
  // generic words: "I'm about to look, help" -> "Helping someone who is struggling" (Romans 12:15
  // shown as a verse about temptation). Topics are embedded like the example messages (query
  // prefix, one at a time) -- without the prefix the matches were clearly worse. A topic counts
  // only when it stands out from the other 99: how many standard deviations the best similarity
  // is above their mean. Measured 2026-10-07: at 3.0, 11/11 clear-cut feeling messages got the
  // right topic ("God feels so distant" 5.3, "how do I tell my wife about my porn problem?" ->
  // Marriage problems 3.5, "I'm addicted and I can't stop" -> Addiction 4.5), "help" -> Helping
  // (2.9) didn't pass, and a plain "can you share a verse" (2.5) didn't either. Two loose word-ish
  // matches did pass ("find me a recovery group" -> Recovering from a mistake 3.1, "give me a
  // bible reading plan" -> Understanding God's plan 5.0), so callers only use a topic for a verse
  // about a feeling or an explicit verse ask (ResourcePicker.verseTopicFor).
  const TOPIC_Z = 3.0;
  let verseTopics = null; // [{ topic, refs, v }]

  async function buildVerseTopics() {
    const rows = typeof ResourceRepo !== "undefined" ? ResourceRepo.getVerseTopics() : [];
    const key = (topic) => `ex1:topic:${topic}`;
    await ensure(rows.map((r) => ({ key: key(r.topic), text: r.topic })), { query: true, chunk: 1 });
    return rows.map((r) => ({ topic: r.topic, refs: r.refs, v: vectors.get(key(r.topic)).v }));
  }

  // { topic, refs, z } for the topic that clearly stands out, else null.
  function matchVerseTopicByMeaning(queryVec) {
    if (!verseTopics || verseTopics.length < 10) return null;
    const sims = verseTopics.map((t) => cosine(queryVec, t.v));
    const mean = sims.reduce((a, b) => a + b, 0) / sims.length;
    const sd = Math.sqrt(sims.reduce((a, s) => a + (s - mean) ** 2, 0) / sims.length) || 1;
    let best = 0;
    for (let i = 1; i < sims.length; i++) if (sims[i] > sims[best]) best = i;
    const z = (sims[best] - mean) / sd;
    return z >= TOPIC_Z ? { topic: verseTopics[best].topic, refs: verseTopics[best].refs, z } : null;
  }

  function isReady() {
    return state === "ready" && !!engine;
  }

  function withTimeout(promise, ms) {
    return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);
  }

  /**
   * One embed of the message: { queryVec, theme, ask } -- theme/ask null unless they clear the
   * calibrated margins. null when the model isn't ready (or too slow), so callers just skip it.
   */
  async function analyze(text) {
    if (!isReady()) return null;
    try {
      const vecs = await withTimeout(embedRaw([QUERY_PREFIX + text]), QUERY_TIMEOUT_MS);
      if (!vecs) return null;
      const queryVec = vecs[0];
      const t = classify(queryVec, themeClasses);
      const a = classify(queryVec, askClasses);
      // Good news isn't a feeling to answer with resources: "I'm proud of my streak" and "longest
      // streak ever for me" read as relapse (margins up to 0.17) because the relapse examples talk
      // about streaks too, and examples alone didn't fix it. A real relapse with these words still
      // gets caught -- by the loss words here, and by the keyword list (slip/relapse/fail).
      const goodNews = GOOD_NEWS.test(text) && !SETBACK.test(text);
      return {
        queryVec,
        theme: t.margin >= THEME_MARGIN && !goodNews ? t.label : null,
        ask: a.margin >= ASK_MARGIN ? a.label : null,
        themeMargin: t.margin,
        askMargin: a.margin,
        verseTopic: matchVerseTopicByMeaning(queryVec),
      };
    } catch (err) {
      console.warn("Embedding failed for this message; continuing without it:", err);
      return null;
    }
  }

  function vectorFor(key) {
    const cached = vectors.get(key);
    return cached ? cached.v : null;
  }

  // Called when someone rates a card, so taste can include things that aren't in the index (a
  // YouVersion verse, a group added since). Fire-and-forget.
  function rememberItem(key, text) {
    // Indexed items already have a vector from their own text; re-embedding the card's wording
    // would just flip-flop with the next index pass.
    if (!isReady() || !key || !text || vectors.has(key)) return;
    ensure([{ key, text: text.slice(0, 600) }]).catch(() => {});
  }

  // Embeds [{ key, text }] that aren't cached yet and resolves once they are (false if the model isn't
  // ready). For things outside the resource index that get ranked -- the daily passages (PassageBank).
  async function ensureItems(items) {
    if (!isReady()) return false;
    await ensure(items.map((it) => ({ key: it.key, text: String(it.text).slice(0, 600) })));
    return true;
  }

  // Direction of "what helped" minus "what didn't", weighted like the thumbs themselves
  // (rows carry their decay weight from ResourceFeedback.weightedRows). null until at least two
  // rated items have vectors -- one rating is too thin to call a taste.
  function tasteVector(weightedRows) {
    let sum = null;
    let used = 0;
    for (const { key, rating, weight } of weightedRows) {
      const v = vectorFor(key);
      if (!v) continue;
      if (!sum) sum = new Float32Array(v.length);
      for (let i = 0; i < v.length; i++) sum[i] += rating * weight * v[i];
      used++;
    }
    if (used < 2) return null;
    let n = 0;
    for (let i = 0; i < sum.length; i++) n += sum[i] * sum[i];
    return n > 1e-6 ? normalize(sum) : null;
  }

  // ---- "tell the user once" if it couldn't load (app.js shows it) ----

  function failureNoticeDue() {
    if (state !== "failed") return false;
    try {
      return localStorage.getItem(FAIL_NOTICE_KEY) !== "1";
    } catch (e) {
      return false;
    }
  }

  function dismissFailureNotice() {
    try {
      localStorage.setItem(FAIL_NOTICE_KEY, "1");
    } catch (e) {}
  }

  function onChange(fn) {
    listeners.add(fn);
  }

  return {
    start,
    isReady,
    analyze,
    vectorFor,
    rememberItem,
    ensureItems,
    tasteVector,
    cosine,
    onChange,
    failureNoticeDue,
    dismissFailureNotice,
    getState: () => state,
  };
})();
