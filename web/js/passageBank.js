/**
 * Which of the daily passages (DAILY_PASSAGES, seedData.js) a risk nudge offers to pray through with the
 * Lectio Divina meditation (lectioView.js) -- chosen by the on-device AI. Nathaniel, 2026-10-07: "have the
 * AI pick one of the daily passages -- prefer today's passage for the first notification, but personalized
 * to the situation like Joey's verse was, and never the same one twice in a day." It replaced the short
 * verse Joey's VerseBank put on the full-screen check-in (RiskOverlay.java): the overlay now shows the
 * passage's reference and one-line description with a "Pray through" button. Joey's method is kept whole.
 *
 * The notifiers -- RiskOverlay/RiskNudgeMonitor on Android, the browser extension on the web -- fire while
 * the app is closed and have no model, so the choosing happens AHEAD of time: while the app is open this
 * builds, for each situation a nudge can be in (the same 8 combinations of reasons the note bank uses, plus
 * "K" for a keyword/temptation nudge, at each of the 4 times of day = 36 situations), the passages ranked
 * best first, and hands them over as part of a "plan" (getPlan) together with the person's upcoming daily
 * passages (DailyPassage.schedule). When a nudge fires, the notifier applies the rule (RiskPassage.java /
 * extension/lib/passagePicker.js -- keep the two in step): today's passage if it hasn't been offered yet
 * today, otherwise the best-ranked one for this situation that hasn't.
 *
 * How the ranking works (all on this device, nothing sent anywhere) -- Joey's, from VerseBank:
 *   1. Two sentences are written: the SITUATION (the time of day, what's going on -- a long stretch on a
 *      flagged app, a hard time of day, being alone) and what THIS person has been struggling with lately
 *      (their recent check-in tags and the triggers they named at setup). They are scored separately,
 *      not merged into one: on the real phone a single combined sentence let the person's (constant)
 *      struggles swamp the situation, so 36 situations produced 7 verses and one comfort verse led 4 of 5.
 *   2. Nathaniel's embedding model (localEmbedder.js) turns each into a vector, and each passage -- its
 *      reference and its one-line description, which says what the passage is about -- is ranked by
 *      closeness in meaning (situation weighted most).
 *   3. Experience shifts the ranking: passages the person marked helpful on the meditation's closing screen
 *      under THESE conditions (same situation and time of day) rise, "not for me" ones fall, and the general
 *      taste learned from their thumbs elsewhere in the app (resourceFeedback.js) nudges it too.
 *   Without the embedding model there is no ranking; the notifiers then go through the person's own upcoming
 *   daily passages instead, so a second nudge still gets a different passage.
 *
 * "Learning from users" here means THIS user, on THIS device; pooling experience across people would need a
 * server, which the app's privacy commitments rule out.
 */
const PassageBank = (function () {
  const BANK_KEY = "reclaim_passage_bank_v1";
  const OUTCOMES_KEY = "reclaim_passage_outcomes_v1";
  const BANK_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
  const BUCKETS = ["Morning", "Afternoon", "Evening", "Night"];
  // Same letters as RiskExplainer.noteSignature / RiskNotificationText.noteSignature, plus K: a keyword
  // nudge, or any nudge without an app/duration clause.
  const SIGS = ["D", "DT", "DL", "DTL", "A", "AT", "AL", "ATL", "K"];
  const PER_KEY = 8; // a person rarely gets more than a few nudges a day; the schedule covers the rest
  const MAX_OUTCOMES = 200;
  const OUTCOME_HALF_LIFE_DAYS = 90;
  // Every signal is a z-score (see rank), so these weights are in standard deviations. Measured with the real
  // embedding model on the 35 passages (browser, 2026-10-07): with a person's recent struggles at 0.35, as
  // VerseBank weighted them, 7 passages led the 36 situations and one led 15; at 0.25 the situation still
  // leads. One "not for me" in the same situation costs 0.6 sd -- enough to drop a passage from first, not to
  // bury it -- and a quarter of that anywhere else.
  const W_SITUATION = 0.75;
  const W_CONTEXT = 0.25;
  const W_TASTE = 0.3;
  const W_OUTCOME = 0.6;

  const WHEN = { Morning: "in the morning", Afternoon: "in the afternoon", Evening: "in the evening", Night: "late at night" };

  // ---- Situation -> a sentence the embedding model can match passages against ----

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

  // ---- Experience: what helped under similar conditions ----

  function readOutcomes() {
    try {
      const v = JSON.parse(localStorage.getItem(OUTCOMES_KEY) || "[]");
      return Array.isArray(v) ? v : [];
    } catch (e) {
      return [];
    }
  }

  // From the meditation's closing screen. `sig`/`bucket` are the nudge's situation; a meditation started from
  // Home has none ("") and so counts a quarter toward every situation.
  function recordOutcome(o) {
    const all = readOutcomes();
    all.push({ at: o.at || Date.now(), ref: o.ref, sig: o.sig || "", bucket: o.bucket || "", rating: o.rating > 0 ? 1 : -1 });
    try {
      localStorage.setItem(OUTCOMES_KEY, JSON.stringify(all.slice(-MAX_OUTCOMES)));
    } catch (e) {}
  }

  // Net experience with one passage for THIS situation: the same situation and time of day counts fully,
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
    const list = typeof DAILY_PASSAGES !== "undefined" ? DAILY_PASSAGES : [];
    return list.filter((p) => p && p.reference).map((p) => ({ ref: p.reference, description: p.description || "" }));
  }

  // Its own vector key, apart from the thumbs key ("verse:<ref>"), so the resource index (which embeds the
  // seed verses under "verse:" keys) and this never overwrite each other's vector for the same reference.
  const vectorKey = (c) => `passage:${c.ref}`;
  const passageText = (c) => (c.description ? `${c.ref}. ${c.description}` : c.ref);

  // "Hubness": some passages sit moderately close to EVERY query in embedding space and so win by default (on
  // the real phone, Joey saw one verse lead 26 of 36 situations). VerseBank's remedy was to score each by how
  // much closer it is to THIS query than to a typical one (its mean over all the situation queries). For the
  // passages that difference is tiny -- a few hundredths -- because the 36 situation sentences mean nearly the
  // same thing to the model, so any other signal (one rating) swamped it: in testing, one "this helped" made
  // Romans 8:31-39 lead 29 of 36. So it's a z-score here: the difference divided by how much THIS passage's
  // closeness varies across situations. Returns { reference: { mean, sd } } over the situation queries.
  function hubScores(cands, queryVecs) {
    const hub = {};
    if (!queryVecs.length) return hub;
    for (const c of cands) {
      const vec = LocalEmbedder.vectorFor(vectorKey(c));
      if (!vec) continue;
      const sims = queryVecs.map((q) => LocalEmbedder.cosine(q, vec));
      const mean = sims.reduce((a, b) => a + b, 0) / sims.length;
      const sd = Math.sqrt(sims.reduce((a, b) => a + (b - mean) ** 2, 0) / sims.length);
      hub[c.ref] = { mean, sd: sd > 1e-6 ? sd : 1e-6 };
    }
    return hub;
  }

  // How close each passage is to one vector (the person's struggles, their taste), as a z-score ACROSS the
  // passages: which ones fit it better than the rest. {} without the vector.
  function standardized(cands, vec) {
    if (!vec) return {};
    const rows = cands.map((c) => [c.ref, LocalEmbedder.vectorFor(vectorKey(c))]).filter(([, v]) => v);
    if (rows.length < 2) return {};
    const sims = rows.map(([, v]) => LocalEmbedder.cosine(vec, v));
    const mean = sims.reduce((a, b) => a + b, 0) / sims.length;
    const sd = Math.sqrt(sims.reduce((a, b) => a + (b - mean) ** 2, 0) / sims.length) || 1;
    const out = {};
    rows.forEach(([ref], i) => (out[ref] = (sims[i] - mean) / sd));
    return out;
  }

  // `ctxZ` / `tasteZ` are standardized() maps for the person's struggles and taste ({} = none).
  function rank(cands, sig, bucket, queryVec, ctxZ, tasteZ, outcomes, now, hub = {}) {
    const hasCtx = Object.keys(ctxZ || {}).length > 0;
    return cands
      .map((c) => {
        const vec = queryVec ? LocalEmbedder.vectorFor(vectorKey(c)) : null;
        let s = 0;
        if (queryVec && vec) {
          const h = hub[c.ref] || { mean: 0, sd: 1 };
          const situation = (LocalEmbedder.cosine(queryVec, vec) - h.mean) / h.sd;
          s += hasCtx ? W_SITUATION * situation + W_CONTEXT * (ctxZ[c.ref] || 0) : situation;
          s += W_TASTE * ((tasteZ || {})[c.ref] || 0);
        }
        s += W_OUTCOME * outcomeScore(c.ref, sig, bucket, outcomes, now);
        return { c, s };
      })
      .sort((a, b) => b.s - a.s);
  }

  // ---- The bank ----

  function readBank() {
    try {
      const stored = JSON.parse(localStorage.getItem(BANK_KEY) || "null");
      return stored && stored.ranked ? stored : null;
    } catch (e) {
      return null;
    }
  }

  // Re-checked on read: only references that are still daily passages, at most PER_KEY per situation.
  function getRanked() {
    const stored = readBank();
    if (!stored) return {};
    const known = new Set(candidates().map((c) => c.ref));
    const out = {};
    for (const [key, list] of Object.entries(stored.ranked)) {
      const ok = (Array.isArray(list) ? list : []).filter((r) => known.has(r)).slice(0, PER_KEY);
      if (ok.length) out[key] = ok;
    }
    return out;
  }

  function notifierPresent() {
    const onAndroid = typeof LocalSignals !== "undefined" && LocalSignals.available();
    const onExtension = typeof WebTracker !== "undefined" && WebTracker.available();
    return onAndroid || onExtension;
  }

  let refreshing = null;

  // Rebuilds the ranking. Quiet and best-effort; keeps the old one if nothing could be built. Only where
  // something posts nudges (Android, or the browser extension), and only with the embedding model -- without
  // it the plan still carries the schedule, which is what the notifiers fall back on.
  function refresh({ force = false } = {}) {
    if (refreshing) return refreshing;
    const embedderReady = typeof LocalEmbedder !== "undefined" && LocalEmbedder.isReady();
    if (!notifierPresent() || !embedderReady) return Promise.resolve(false);
    const stored = readBank();
    const cands = candidates();
    const stale = !stored || Date.now() - stored.at > BANK_MAX_AGE_MS || stored.n !== cands.length;
    if (!force && !stale) return Promise.resolve(false);
    refreshing = (async () => {
      const now = Date.now();
      if (!cands.length) return false;
      await LocalEmbedder.ensureItems(cands.map((c) => ({ key: vectorKey(c), text: passageText(c) })));
      const outcomes = readOutcomes();
      let taste = null;
      try {
        taste = LocalEmbedder.tasteVector(ResourceFeedback.weightedRows(now));
      } catch (e) {}
      let ctxVec = null;
      const ctxText = contextText(recentContext(now));
      if (ctxText) {
        try {
          const a = await LocalEmbedder.analyze(ctxText);
          ctxVec = a ? a.queryVec : null;
        } catch (e) {}
      }
      // 1) embed every situation, 2) rank each (correcting for hub passages)
      const queries = [];
      for (const sig of SIGS) {
        for (const bucket of BUCKETS) {
          let queryVec = null;
          try {
            const a = await LocalEmbedder.analyze(situationText(sig, bucket));
            queryVec = a ? a.queryVec : null;
          } catch (e) {}
          if (queryVec) queries.push({ key: `${sig}|${bucket}`, sig, bucket, queryVec });
        }
      }
      if (!queries.length) return false;
      const hub = hubScores(cands, queries.map((q) => q.queryVec));
      const ctxZ = standardized(cands, ctxVec);
      const tasteZ = standardized(cands, taste);
      const ranked = {};
      for (const q of queries) {
        ranked[q.key] = rank(cands, q.sig, q.bucket, q.queryVec, ctxZ, tasteZ, outcomes, now, hub)
          .slice(0, PER_KEY)
          .map((r) => r.c.ref);
      }
      try {
        localStorage.setItem(BANK_KEY, JSON.stringify({ at: now, n: cands.length, ranked }));
      } catch (e) {}
      if (typeof RiskProfile !== "undefined") RiskProfile.syncToNative();
      return true;
    })()
      .catch((err) => {
        console.warn("Passage bank refresh failed:", err);
        return false;
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  }

  /**
   * What the notifiers need to pick a passage with no model and no app open (synced by RiskProfile):
   *   passages  { reference: description } -- the reference and line shown on the overlay / notification
   *   schedule  [{ day, ref }] -- this person's daily passage for today and the coming weeks
   *   ranked    { "<sig>|<bucket>": [reference, ...] } -- best first, for nudges after today's has been offered
   *   used      { day, refs } -- passages already prayed through in the app today
   */
  function getPlan(date = new Date()) {
    const passages = {};
    for (const c of candidates()) passages[c.ref] = c.description;
    let schedule = [];
    let used = { day: 0, refs: [] };
    if (typeof DailyPassage !== "undefined") {
      try {
        schedule = DailyPassage.schedule(date);
        used = { day: DailyPassage.dayNumber(date), refs: DailyPassage.usedToday(date) };
      } catch (e) {}
    }
    return { passages, schedule, ranked: getRanked(), used };
  }

  return {
    refresh,
    getPlan,
    recordOutcome,
    SIGS,
    BUCKETS,
    // exposed for tests
    _situationText: situationText,
    _contextText: contextText,
    _recentContext: recentContext,
    _outcomeScore: outcomeScore,
    _rank: rank,
    _hubScores: hubScores,
    _standardized: standardized,
    _readOutcomes: readOutcomes,
  };
})();
