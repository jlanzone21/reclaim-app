/**
 * The Bible verse shown on the full-screen check-in (RiskOverlay.java), chosen by the on-device AI.
 *
 * The overlay is native and draws instantly with no WebView, so the verse has to be decided AHEAD of
 * time: while the app is open this builds a bank -- for each situation a nudge can be in (the same 8
 * combinations of reasons the note bank uses, plus "K" for a keyword/temptation nudge, at each of the 4
 * times of day = 36 situations) the 3 best verses, WITH their text and the translation's required
 * attribution -- and mirrors it to the native layer. When a nudge fires, native just picks one.
 *
 * How a verse is chosen (all on this device, nothing sent anywhere):
 *   1. Two sentences are written: the SITUATION (the time of day, what's going on -- a long stretch on a
 *      flagged app, a hard time of day, being alone) and what THIS person has been struggling with lately
 *      (their recent check-in tags and the triggers they named at setup). They are scored separately,
 *      not merged into one: on the real phone a single combined sentence let the person's (constant)
 *      struggles swamp the situation, so 36 situations produced 7 verses and one comfort verse led 4 of 5.
 *   2. Nathaniel's embedding model (localEmbedder.js) turns each into a vector and every candidate verse
 *      is ranked by closeness in meaning (situation weighted most), so "late at night, alone" and
 *      "lately lonely and stressed" both find verses about loneliness and rest, not whichever verse a
 *      keyword happened to hit.
 *   3. Experience shifts the ranking: verses the person marked helpful under THESE conditions (same
 *      situation and time of day) rise, ones marked "not for me" fall, and the general taste learned
 *      from their thumbs elsewhere in the app (resourceFeedback.js) nudges it too.
 *   Without the embedding model the same ranking runs on the verses' tags, so it still works.
 *
 * "Learning from users" here means THIS user, on THIS device: the verse feedback on the overlay ("This
 * helped" / "Not for me") is parked natively (RiskFeedbackNotes.addVerseFeedback), picked up here the
 * next time the app opens, recorded both as a normal thumbs rating and as an outcome tied to the
 * situation, and the bank is rebuilt. Nothing leaves the phone; pooling experience across people would
 * need a server, which the app's privacy commitments rule out.
 *
 * Scripture text comes from YouVersion (with the copyright attribution it requires) when available,
 * else the app's bundled text for that verse -- the same fallback the chat cards use.
 */
const VerseBank = (function () {
  const BANK_KEY = "reclaim_verse_bank_v4"; // v4: no shared tail in the situation sentence (v3: 9 verses for 36 situations)
  const OUTCOMES_KEY = "reclaim_verse_outcomes_v1";
  const BANK_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
  const BUCKETS = ["Morning", "Afternoon", "Evening", "Night"];
  // Same letters as RiskExplainer.noteSignature / RiskNotificationText.noteSignature, plus K: a keyword
  // nudge, or any nudge without an app/duration clause.
  const SIGS = ["D", "DT", "DL", "DTL", "A", "AT", "AL", "ATL", "K"];
  const PER_KEY = 4;
  const MAX_TEXT = 300; // the overlay is a glance, not a reading: shorter verses only
  const MAX_OUTCOMES = 200;
  const OUTCOME_HALF_LIFE_DAYS = 90;
  const W_TASTE = 0.3;
  const W_OUTCOME = 0.12;
  const W_TAGS = 0.1;

  const WHEN = { Morning: "in the morning", Afternoon: "in the afternoon", Evening: "in the evening", Night: "late at night" };

  // ---- Situation -> a sentence the embedding model can match verses against ----

  function recentContext(now = Date.now()) {
    const tags = {};
    let slips = 0;
    try {
      for (const c of CheckInStore.list()) {
        if (now - new Date(c.timestamp).getTime() > 30 * 86400000) continue;
        if (c.type === "slipped") slips++;
        for (const t of c.tags || []) if (t !== "Other") tags[t] = (tags[t] || 0) + (c.type === "slipped" ? 2 : 1);
      }
    } catch (e) {}
    let triggers = [];
    try {
      triggers = UserPreferencesStore.get().common_triggers || [];
    } catch (e) {}
    const ranked = Object.entries(tags).sort((a, b) => b[1] - a[1]).map(([t]) => t);
    return { tags: [...new Set([...ranked, ...triggers])].slice(0, 4).map((t) => t.toLowerCase()), slips };
  }

  // What THIS person has been going through lately, scored apart from the situation (see the header).
  function contextText(ctx) {
    return ctx.tags.length ? `Lately they have struggled with ${ctx.tags.join(", ")}. They are looking for comfort and strength.` : null;
  }

  function situationText(sig, bucket) {
    const parts = [`It is ${WHEN[bucket] || "right now"}.`];
    if (sig === "K") {
      parts.push("They are in a moment of temptation right now.");
    } else {
      const long = sig.startsWith("D");
      parts.push(long ? "They have been on an app they flagged as a trigger for a long while" : "They are on an app they flagged as a trigger");
      if (sig.includes("T")) parts[1] += ", at a hard time of day for them";
      if (sig.includes("L")) parts[1] += ", alone with no one nearby";
      parts[1] += ".";
    }
    // No shared closing line ("they need hope and strength..."): on the real phone a tail common to all 36
    // situations pulled every query into the same neighbourhood and the same few verses won everywhere.
    return parts.join(" ");
  }

  // Words a situation "means", for ranking by tags when the embedding model isn't available.
  function situationTags(sig, bucket, ctx) {
    const t = ["temptation", "triggers", "struggle", "hope", "in-the-moment"];
    if (sig.includes("L")) t.push("loneliness", "community");
    if (sig.includes("T") || bucket === "Night") t.push("anxiety", "stress");
    if (sig.startsWith("D")) t.push("perseverance", "freedom");
    return [...new Set([...t, ...ctx.tags])];
  }

  // ---- Experience: what helped under similar conditions ----

  function readOutcomes() {
    try {
      const v = JSON.parse(localStorage.getItem(OUTCOMES_KEY) || "[]");
      return Array.isArray(v) ? v : [];
    } catch (e) {
      return [];
    }
  }

  function recordOutcome(o) {
    const all = readOutcomes();
    all.push({ at: o.at || Date.now(), ref: o.ref, sig: o.sig, bucket: o.bucket, rating: o.rating > 0 ? 1 : -1 });
    try {
      localStorage.setItem(OUTCOMES_KEY, JSON.stringify(all.slice(-MAX_OUTCOMES)));
    } catch (e) {}
  }

  // Net experience with one verse for THIS situation: the same situation and time of day counts fully,
  // the same situation at another time half, anything else a quarter; older outcomes fade.
  function outcomeScore(ref, sig, bucket, outcomes, now) {
    let s = 0;
    for (const o of outcomes) {
      if (o.ref !== ref) continue;
      const closeness = o.sig === sig && o.bucket === bucket ? 1 : o.sig === sig ? 0.5 : 0.25;
      const fade = Math.pow(0.5, (now - o.at) / (OUTCOME_HALF_LIFE_DAYS * 86400000));
      s += o.rating * closeness * fade;
    }
    return s;
  }

  // ---- Candidates and ranking ----

  function candidates() {
    return DB.all("SELECT title, body, tags FROM resources WHERE type = 'scripture'")
      .map((r) => ({ title: r.title, body: r.body || "", tags: r.tags ? JSON.parse(r.tags) : [] }))
      .filter((r) => r.body && r.body.length <= MAX_TEXT);
  }

  const W_SITUATION = 0.65; // of the meaning score, when there's also a personal-context vector
  const W_CONTEXT = 0.35;

  // "Hubness": some verses (on the real phone, Isaiah 41:10) sit moderately close to EVERY query in embedding
  // space and so win by default -- 8 distinct verses across 36 situations, one leading 26 of them. The standard
  // remedy: score each verse by how much closer it is to THIS query than it is to a typical one. `hub` maps a
  // verse's reference to its mean similarity over all the situation queries (empty = no correction).
  function hubScores(cands, queryVecs) {
    const hub = {};
    if (!queryVecs.length) return hub;
    for (const v of cands) {
      const vec = typeof LocalEmbedder !== "undefined" ? LocalEmbedder.vectorFor(ResourceFeedback.describe("scripture_search", v).key) : null;
      if (!vec) continue;
      hub[v.title] = queryVecs.reduce((s, q) => s + LocalEmbedder.cosine(q, vec), 0) / queryVecs.length;
    }
    return hub;
  }

  function rank(cands, sig, bucket, ctx, queryVec, ctxVec, taste, outcomes, now, hub = {}) {
    const wanted = new Set(situationTags(sig, bucket, ctx));
    return cands
      .map((v) => {
        const vec = typeof LocalEmbedder !== "undefined" && queryVec ? LocalEmbedder.vectorFor(ResourceFeedback.describe("scripture_search", v).key) : null;
        let s = 0;
        if (queryVec && vec) {
          const h = hub[v.title] || 0;
          s += ctxVec
            ? W_SITUATION * (LocalEmbedder.cosine(queryVec, vec) - h) + W_CONTEXT * (LocalEmbedder.cosine(ctxVec, vec) - h)
            : LocalEmbedder.cosine(queryVec, vec) - h;
          if (taste) s += W_TASTE * LocalEmbedder.cosine(taste, vec);
        }
        // Tags always count (a little); they are the whole signal when there is no embedding.
        const overlap = v.tags.filter((t) => wanted.has(String(t).toLowerCase())).length;
        s += W_TAGS * overlap;
        s += W_OUTCOME * outcomeScore(v.title, sig, bucket, outcomes, now);
        return { v, s };
      })
      .sort((a, b) => b.s - a.s);
  }

  // ---- Verse text ----

  // YouVersion's passage HTML -> plain text for the native overlay. The SDK sanitizes the HTML; this only
  // drops verse-number/label/note spans, strips tags and decodes the few entities it uses.
  function plainText(html) {
    return String(html || "")
      .replace(/<span[^>]*class="[^"]*(?:vlbl|label|note|heading|fn)[^"]*"[^>]*>[\s\S]*?<\/span>/gi, " ")
      .replace(/<sup[^>]*>[\s\S]*?<\/sup>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;|&#160;/g, " ")
      .replace(/&ldquo;|&rdquo;|&quot;|&#34;/g, '"')
      .replace(/&lsquo;|&rsquo;|&#39;|&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
  }

  async function verseText(v) {
    if (typeof YouVersion !== "undefined" && YouVersion.available()) {
      try {
        const d = await YouVersion.getVerse(v.title);
        const text = d ? plainText(d.html) : "";
        if (text && text.length <= MAX_TEXT + 60) {
          const abbr = d.version && (d.version.localized_abbreviation || d.version.abbreviation);
          // YouVersion's attribution is a multi-line block; the overlay shows it as one small paragraph.
          const copyright = d.attribution && d.attribution.text ? d.attribution.text.replace(/\s+/g, " ").trim() : "";
          return { ref: d.reference || v.title, text, attribution: [abbr, copyright].filter(Boolean).join(" · ") };
        }
      } catch (e) {}
    }
    return { ref: v.title, text: v.body, attribution: "" };
  }

  // ---- The bank ----

  function readBank() {
    try {
      const stored = JSON.parse(localStorage.getItem(BANK_KEY) || "null");
      return stored && stored.bank ? stored : null;
    } catch (e) {
      return null;
    }
  }

  function validEntry(e) {
    return e && typeof e.ref === "string" && e.ref && typeof e.text === "string" && e.text.length > 10 && e.text.length <= MAX_TEXT + 60;
  }

  // Re-checked on read, like the other banks: only well-formed verses go to the native layer.
  function getBank() {
    const stored = readBank();
    if (!stored) return {};
    const out = {};
    for (const [key, list] of Object.entries(stored.bank)) {
      const ok = (Array.isArray(list) ? list : []).filter(validEntry).slice(0, PER_KEY);
      if (ok.length) out[key] = ok.map((e) => ({ ref: e.ref, text: e.text, attribution: String(e.attribution || "") }));
    }
    return out;
  }

  let refreshing = null;

  // Rebuilds the bank. Quiet and best-effort; keeps the old bank if nothing could be built.
  function refresh({ force = false } = {}) {
    if (refreshing) return refreshing;
    const onAndroid = typeof LocalSignals !== "undefined" && LocalSignals.available();
    const stored = readBank();
    const embedderReady = typeof LocalEmbedder !== "undefined" && LocalEmbedder.isReady();
    // A bank built before the embedding model was ready is rebuilt once it is.
    const stale = !stored || Date.now() - stored.at > BANK_MAX_AGE_MS || (embedderReady && !stored.usedEmbeddings);
    if (!onAndroid || (!force && !stale)) return Promise.resolve(false);
    refreshing = (async () => {
      const now = Date.now();
      const cands = candidates();
      if (!cands.length) return false;
      const ctx = recentContext(now);
      const outcomes = readOutcomes();
      let taste = null;
      let ctxVec = null;
      if (embedderReady) {
        try {
          taste = LocalEmbedder.tasteVector(ResourceFeedback.weightedRows(now));
        } catch (e) {}
        const ctxText = contextText(ctx);
        if (ctxText) {
          try {
            const a = await LocalEmbedder.analyze(ctxText);
            ctxVec = a ? a.queryVec : null;
          } catch (e) {}
        }
      }
      // 1) embed every situation, 2) rank each (correcting for hub verses), 3) fetch text once per distinct verse
      const queries = {};
      for (const sig of SIGS) {
        for (const bucket of BUCKETS) {
          let queryVec = null;
          if (embedderReady) {
            try {
              const a = await LocalEmbedder.analyze(situationText(sig, bucket));
              queryVec = a ? a.queryVec : null;
            } catch (e) {}
          }
          queries[`${sig}|${bucket}`] = { sig, bucket, queryVec };
        }
      }
      const hub = hubScores(cands, Object.values(queries).map((q) => q.queryVec).filter(Boolean));
      const picks = {};
      for (const [key, q] of Object.entries(queries)) {
        picks[key] = rank(cands, q.sig, q.bucket, ctx, q.queryVec, ctxVec, taste, outcomes, now, hub).slice(0, PER_KEY).map((r) => r.v);
      }
      const byRef = new Map();
      for (const list of Object.values(picks)) for (const v of list) if (!byRef.has(v.title)) byRef.set(v.title, v);
      const texts = new Map();
      const queue = [...byRef.values()];
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          while (queue.length) {
            const v = queue.shift();
            texts.set(v.title, await verseText(v));
          }
        })
      );
      const bank = {};
      for (const [key, list] of Object.entries(picks)) bank[key] = list.map((v) => texts.get(v.title)).filter(validEntry);
      try {
        localStorage.setItem(BANK_KEY, JSON.stringify({ at: now, usedEmbeddings: !!embedderReady, bank }));
      } catch (e) {}
      if (typeof RiskProfile !== "undefined") RiskProfile.syncToNative();
      return true;
    })()
      .catch((err) => {
        console.warn("Verse bank refresh failed:", err);
        return false;
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  }

  // ---- Feedback from the overlay ----

  // Reads the "This helped" / "Not for me" taps parked by RiskOverlay while the app was closed: each
  // becomes an ordinary thumbs rating (so chat's resource picker learns from it too) AND an outcome tied
  // to the situation it happened in, then the bank is rebuilt so the next nudge reflects it.
  async function processFeedback() {
    if (typeof LocalSignals === "undefined" || !LocalSignals.available()) return { processed: 0 };
    let rows = [];
    try {
      rows = await LocalSignals.takePendingVerseFeedback();
    } catch (e) {
      return { processed: 0 };
    }
    let processed = 0;
    for (const r of rows) {
      if (!r || !r.ref || !r.rating) continue;
      const seed = candidates().find((c) => c.title === r.ref) || { title: r.ref, body: r.text || "", tags: [] };
      try {
        const entry = ResourceFeedback.describe("scripture_search", seed);
        ResourceFeedback.rate(null, entry, r.rating > 0 ? 1 : -1);
        if (typeof LocalEmbedder !== "undefined") LocalEmbedder.rememberItem(entry.key, `${seed.title}. ${seed.body}`);
      } catch (e) {}
      recordOutcome({ at: r.at, ref: r.ref, sig: r.sig || "K", bucket: r.bucket || "Night", rating: r.rating });
      processed++;
    }
    if (processed) refresh({ force: true });
    return { processed };
  }

  return {
    refresh,
    processFeedback,
    getBank,
    recordOutcome,
    SIGS,
    BUCKETS,
    // exposed for tests
    _situationText: situationText,
    _contextText: contextText,
    _recentContext: recentContext,
    _plainText: plainText,
    _outcomeScore: outcomeScore,
    _rank: rank,
    _hubScores: hubScores,
    _readOutcomes: readOutcomes,
  };
})();
