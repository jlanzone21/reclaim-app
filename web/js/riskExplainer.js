/**
 * The on-device AI's part in risk nudges -- three jobs, all grounded in what RiskScorer actually
 * did (its "trace": every factor, whether it fired, the points, the values -- see RiskScorer.java's
 * class doc, "Explainability"), none of them guessing:
 *
 *   1. explain(alert)            writes the short, personal note at the top of the alert screen
 *                                ("It's late and you've been on Instagram for 22 minutes...").
 *   2. interpretFeedback(...)    reads the person's own words about whether the nudge was fair and
 *                                labels them fair / false alarm, which the app shows back for
 *                                confirmation before anything is changed.
 *   3. refreshPhraseBank()       writes the phrase templates the background notification uses.
 *                                The model can't run while the app is closed, so it authors the
 *                                wording ahead of time ({app}/{minutes}/{time} slots) and native
 *                                code (RiskNotificationText / extension/lib/notificationText.js)
 *                                fills in the live values when a notification fires.
 *
 * The model never gets to be the last word. Every output is checked in code first -- the shared
 * unsafe-sentence filter (reclaimAgent.js), a deny-list for anything claiming what was viewed or
 * that they slipped, and a "grounding" check that no number appears that isn't in the trace -- and
 * a deterministic template (built from the trace, no model) is what shows if any check fails, the
 * model isn't downloaded, or it takes too long. Feedback is the same: the model proposes
 * {verdict, factors}, code validates it against the factors that really fired, the person
 * confirms, and only then does the existing bounded +/-2 weight nudge run (never by the model).
 *
 * No example sentences in any prompt below: the small model copies them as its default output
 * (see AGENT_SYSTEM_PROMPT's note in CLAUDE.md).
 */
const RiskExplainer = (function () {
  // What each factor means, in the words the person sees. `label` names it in the "which part
  // didn't fit?" chips and the "see the numbers" view; `adjustable` mirrors RiskScorer's
  // WEIGHT_SPECS (the SEVERE keyword tier is deliberately fixed, so feedback can't tune it).
  const FACTOR_GUIDE = {
    triggerApp: { label: "Being on an app or site you flagged", adjustable: true },
    duration: { label: "How long you'd been there", adjustable: true },
    selfReportedTime: { label: "A time of day you said is hard", adjustable: true },
    historicalTime: { label: "A time of day that's been hard before", adjustable: true },
    socialMedia: { label: "Social media", adjustable: true },
    alone: { label: "No one else nearby", adjustable: true },
    recentKeyword: { label: "Something on screen that matched a flagged word", adjustable: true },
    recentKeywordMild: { label: "Something on screen worth noticing", adjustable: true },
    recentKeywordSevere: { label: "Something explicit on screen", adjustable: false },
  };
  const ADJUSTMENT_LABELS = {
    convergence: "Several signals at once",
    recentReclaimUse: "You opened Reclaim recently",
  };

  const TIME_PHRASE = { Morning: "this morning", Afternoon: "this afternoon", Evening: "this evening", Night: "late tonight" };

  // The model is never told, and must never claim, what was actually on screen or viewed -- the
  // scorer only knows a keyword matched, not what the person was doing. Same for relapse claims.
  const CLAIMS_DENIED = /\b(porn\w*|nude\w*|naked|explicit|sex\w*|masturbat\w*|erotic\w*|xxx|nsfw|fetish\w*|slip(?:ped|ping)?|relaps\w*|you failed|watching|wonderful|great|enjoy\w*|fun)\b/i;
  const MODEL_WAIT_MS = 30000;

  const fired = (alert) => ((alert && alert.trace && alert.trace.factors) || []).filter((f) => f.fired);
  const labelOf = (id) => (FACTOR_GUIDE[id] ? FACTOR_GUIDE[id].label : id);

  // ---- Deterministic text (no model): also what shows whenever the model can't or shouldn't ----

  // One or two plain sentences built straight from the trace. The same words the lock-screen text
  // uses, so even without the AI the alert screen reads as specific, not generic.
  // The factual part only (no closing invitation), or null when there's nothing specific to say
  // beyond the generic line. `keyword` tells explain() to leave this alert to the template.
  function leadFor(alert) {
    const f = fired(alert);
    const ids = new Set(f.map((x) => x.id));
    const app = alert && alert.appLabel ? alert.appLabel : null;
    const t = alert && alert.trace;
    const minutes = t && Number.isFinite(t.sessionMinutes) ? t.sessionMinutes : null;
    const when = t && TIME_PHRASE[t.timeBucket];
    const bits = [];
    if (app && minutes >= 1 && ids.has("duration")) bits.push(`you've been on ${app} for ${minutes} minutes`);
    else if (app) bits.push(`you're on ${app}`);
    if (ids.has("socialMedia")) bits.push("it's social media, which you flagged as a trigger");
    else if (ids.has("triggerApp") && !(app && minutes >= 1 && ids.has("duration"))) bits.push("it's one you flagged as a trigger");
    if ((ids.has("selfReportedTime") || ids.has("historicalTime")) && when) bits.push(`it's ${when}, a hard time of day for you`);
    if (ids.has("alone")) bits.push("no one else seems to be nearby");
    const keyword = ids.has("recentKeywordSevere") || ids.has("recentKeyword") || ids.has("recentKeywordMild");
    let first = "";
    if (bits.length) first = `${bits.slice(0, 3).join(", and ")}.`.replace(/^./, (c) => c.toUpperCase());
    if (keyword) first = `${first ? first + " " : ""}Something on your screen also caught our attention.`;
    if (!first) first = "A few things lined up that made this a good moment to pause.";
    return { text: first, keyword, minutes, app };
  }

  function templateSummary(alert) {
    return `${leadFor(alert).text} Let's check in.`;
  }

  // The "see the numbers" rows: what the scorer did, in order, with the real points.
  function numbersFor(alert) {
    const t = alert && alert.trace;
    if (!t) return null;
    return {
      score: t.score,
      threshold: t.threshold,
      highRisk: !!t.highRisk,
      rows: [
        ...(t.factors || []).map((f) => ({ label: labelOf(f.id), points: f.fired ? f.points : 0, fired: f.fired, detail: f.detail })),
        ...(t.adjustments || []).map((a) => ({ label: ADJUSTMENT_LABELS[a.id] || a.id, points: a.points, fired: true, detail: a.detail })),
      ],
    };
  }

  // ---- Model plumbing ----

  // Resolves true once the model can be used, false if it isn't going to be in time. Waits only
  // while it's loading from cache (seconds) -- never while downloading (a ~1 GB opt-in).
  function whenModelReady(maxMs) {
    if (typeof LocalModel === "undefined") return Promise.resolve(false);
    return new Promise((resolve) => {
      const started = Date.now();
      const check = () => {
        if (LocalModel.isReady()) return resolve(true);
        const state = LocalModel.getStatus().state;
        if (state !== "loading" && state !== "checking") return resolve(false);
        if (Date.now() - started > maxMs) return resolve(false);
        setTimeout(check, 400);
      };
      check();
    });
  }

  function withTimeout(promise, ms) {
    return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("model timed out")), ms))]);
  }

  async function ask(system, user, { maxTokens = 100, temperature = 0.3 } = {}) {
    const { text } = await LocalModel.streamChat(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { maxTokens, temperature, onDelta: () => true }
    );
    return text.trim();
  }

  function splitSentences(text) {
    return (text.match(/[^.!?]+[.!?]+["'”’)]*|[^.!?]+$/g) || []).map((s) => s.trim()).filter(Boolean);
  }

  function isSafe(sentence) {
    const filter = typeof isSafeSentence === "function" ? isSafeSentence : () => true;
    return filter(sentence) && !CLAIMS_DENIED.test(sentence);
  }

  // Keeps only the sentences that pass the shared safety filter and the claims deny-list.
  function safeSentences(text) {
    return splitSentences(text).filter(isSafe);
  }

  // ---- 1. The note on the alert screen ----
  //
  // Found on a real phone (Qwen3.5-2B): asked to write the note FROM the facts, the model invented
  // feelings ("overwhelmed"), leaked scorer internals ("15 points left", "keyword tier"), used the
  // accountability partner's name as if it were the person's own, and took 20-28 s. Asked to
  // REWRITE a sentence the code already wrote, it is faster (~8 s) and mostly faithful -- so that is
  // the job: code states the facts, the model makes them sound human and adds the invitation, and
  // code then checks the result against the sentence it was given (see grounded()).

  // The purpose is spelled out because, measured on a real phone, a bare "You've been on Chrome for 22
  // minutes." reads as a neutral greeting to the model: 4 of 6 rewrites cheered ("I hope you're
  // having a wonderful time") and only 2 of 6 passed the checks. With the purpose stated (system
  // prompt + a one-line goal after the sentence) 6 of 6 did, and read as intended.
  const EXPLAIN_SYSTEM = `You rewrite a short note from a caring recovery app. The app is checking in because it wants the person to pause for a moment. It is NOT a greeting and NOT praise: never wish them a good time or say anything is great. Keep every fact exactly as given, add nothing new (no feelings, reasons, guesses, names or numbers), then add one short, gentle sentence inviting them to pause and check in. Two sentences total. Output only the two sentences.`;
  const EXPLAIN_GOAL = "(Goal: gently invite them to pause and check in.)";
  // Words from the goal line the model may echo back, on top of the sentence it was given.
  const EXPLAIN_GOAL_WORDS = "pause check in invite";

  // Words the rewrite may use beyond the ones in the sentence it was given: plain function words
  // and the vocabulary of a gentle invitation. Deliberately no feelings, states or reasons -- a word
  // that isn't here or in the input is something the model added, and that is what gets rejected.
  const ALLOWED_EXTRA = new Set(`
    the a an and or but so if then than that this these those it its it's there here now just right
    you your you've you're yourself we our us let's lets i i'm me my
    is are be been being was were am do does did have has had can could would may might will
    for on in at of to with by from as about around back into out up down over
    when whenever while whether how what who which
    not no one else more most some any all very really quite little bit
    check checking checked moment minute take taking step stepping pause pausing breath
    gentle gently ready talk talking together share quick quickly care please
    notice noticed noticing see saw seems seem looks look like
    long lately again still also too even
    wanted want wonder wondering thought thinking time day
    spent spend spending been`.split(/\s+/).filter(Boolean));

  const stem = (w) => w.replace(/'s$/, "").replace(/(?:ing|ed|ly|es|s)$/, "");

  // The rewrite must (1) be plain ASCII (the model has emitted stray CJK characters), (2) keep the
  // app name and the minutes when the input had them, (3) introduce no number the input didn't
  // have, and (4) use only words from the input or ALLOWED_EXTRA.
  function grounded(output, input, { app, minutes }) {
    if (/[^\x20-\x7E\n\u2019\u201C\u201D\u2014\u2026]/.test(output)) return false;
    if (app && !output.includes(app)) return false;
    if (Number.isFinite(minutes) && minutes >= 1 && !new RegExp(`\\b${minutes}\\b`).test(output)) return false;
    const allowedNumbers = new Set(input.match(/\d+/g) || []);
    if ((output.match(/\d+/g) || []).some((n) => !allowedNumbers.has(n))) return false;
    return vocabOk(output, input);
  }

  // Every word must come from the input or ALLOWED_EXTRA -- i.e. a paraphrase, nothing added.
  function vocabOk(output, input) {
    const known = new Set([...(input.toLowerCase().match(/[a-z']+/g) || []).map(stem), ...[...ALLOWED_EXTRA].map(stem)]);
    return (output.toLowerCase().match(/[a-z']+/g) || []).every((w) => w.length <= 2 || known.has(stem(w)));
  }

  // Resolves {text, source: "ai" | "template"}. Never rejects.
  async function explain(alert) {
    const template = templateSummary(alert);
    const fallback = { text: template, source: "template" };
    if (!alert || !alert.trace) return fallback;
    const lead = leadFor(alert);
    // Anything involving the keyword factors stays the fixed wording, never model-written: a model
    // must not be the one talking about what may have been on someone's screen.
    if (lead.keyword || !(await whenModelReady(MODEL_WAIT_MS))) return fallback;
    try {
      const raw = await withTimeout(ask(EXPLAIN_SYSTEM, `${lead.text}\n${EXPLAIN_GOAL}`, { maxTokens: 60, temperature: 0.3 }), MODEL_WAIT_MS);
      // All-or-nothing on the two sentences asked for: a note where the model said something
      // unsafe and the rest happens to be fine is a model that can't be trusted this time, so it
      // falls back to the template rather than showing a trimmed version of an unreliable reply.
      const parts = splitSentences(raw.replace(/\s*\n+\s*/g, " ")).slice(0, 2);
      let text = parts.join(" ");
      if (!parts.length || !parts.every(isSafe) || text.length > 260 || !grounded(text, `${lead.text} ${EXPLAIN_GOAL_WORDS}`, lead)) return fallback;
      // The model often restates the facts and forgets the invitation (seen on a real phone). The
      // facts passed every check, so keep them and add the one fixed line the template uses.
      if (!/\bcheck/i.test(text)) text += " Let's check in.";
      return { text, source: "ai" };
    } catch (err) {
      console.warn("AI explanation failed, using the built-in wording:", err);
      return fallback;
    }
  }

  // ---- 2. The person's own words about the nudge ----

  // Measured on a real Pixel 8a (Qwen3.5-2B): asked for JSON {verdict, reasons, reply}, the model
  // called 3 of 8 plain false alarms "fair", picked reasons at random and wrote odd replies ("a great
  // time to be texting your sister"). Asked for ONE WORD with definitions and a few labeled examples
  // it got 12 of 14 right in ~5 s -- so that is all it is asked for. Its two misses ("this is
  // annoying, stop sending me these", "maybe") are why a cue-word cross-check also runs: when the
  // cues contradict the model, or the reply is a hedge, nothing is proposed and the buttons remain.
  // The acknowledgement is fixed wording, not the model's.
  const FEEDBACK_SYSTEM = `A recovery app sent someone a check-in because it noticed risky signs. The person then replied about it. Label their reply with exactly one word:
FAIR - they agree the check-in was warranted or helpful, or admit they were struggling or on there too long.
FALSE - they say it was a false alarm: nothing was wrong, they were doing something harmless (work, homework, texting someone, checking a message), or the app misjudged them.
UNSURE - anything else, or you cannot tell.
Examples:
"I was just doing homework" -> FALSE
"honestly I needed that nudge" -> FAIR
"nothing was going on, I was texting my mom" -> FALSE
"yeah I was spiraling" -> FAIR
"idk" -> UNSURE
"I was on there longer than I wanted" -> FAIR
Reply with only the one word.`;

  const FEEDBACK_REPLY = {
    fair: "Thanks for telling me — I'll keep an eye out for that.",
    false_alarm: "Thanks for telling me — I'll be less quick to flag that.",
  };

  const FALSE_CUES = /\b(false alarm|wrong|mistake|unnecessary|not (?:a )?(?:problem|issue)|wasn'?t (?:a )?(?:problem|issue|tempt\w*|that)|nothing (?:wrong|bad|was|happening)|no reason|just (?:\w+ ){0,3}(?:homework|work|texting|studying|checking|reading|listening|messag\w+|call\w*|email\w*|school|class)|homework|studying|for (?:work|school|class)|at (?:work|school)|stop sending|annoying|not about|i'?m (?:fine|okay|ok)\b|i was (?:fine|okay|ok)\b)/i;
  const FAIR_CUES = /\b(fair|good (?:call|catch|timing)|needed (?:that|it|this)|helpful|you'?re right|true|spiral\w*|struggl\w*|tempted|was about to|too long|longer than|didn'?t realize|glad|well[- ]timed|shouldn'?t have|regret\w*|why you sent|close to)\b/i;
  const HEDGE = /^\W*(?:maybe|idk|i don'?t know|not sure|dunno|unsure|kinda|sort of|i guess)\b/i;
  // No verdict in it at all: a bare acknowledgement or a question ("okay", "what does that mean").
  // Found on a real phone: the model labelled both FAIR. A bare yes/no is left to the buttons too --
  // the box says "in your own words", so those are ambiguous about what they're answering.
  const NO_VERDICT = /^\W*(?:ok(?:ay)?|k|sure|fine|yes|yeah|yep|no|nah|nope|huh|hmm+|what\b[^]*|why\b[^]*|how\b[^]*)\W*$|\?\s*$/i;

  // Resolves {verdict: "fair" | "false_alarm", factors: string[], reply} or null if the model isn't
  // available, is unsure, or contradicts the cue words (the buttons are always there as the
  // fallback). `factors` is [] for a false alarm (= every factor that fired, unless the person
  // narrows it with the chips) and every fired factor for "fair" -- the model is not trusted to
  // pick which part didn't fit (it was no better than chance), and only ids that really fired in
  // THIS alert can ever come back.
  async function interpretFeedback(alert, userText) {
    const f = fired(alert);
    if (!f.length || !userText || !(await whenModelReady(5000))) return null;
    const said = userText.slice(0, 400);
    if (HEDGE.test(said) || NO_VERDICT.test(said)) return null;
    try {
      const raw = await withTimeout(ask(FEEDBACK_SYSTEM, said, { maxTokens: 6, temperature: 0 }), MODEL_WAIT_MS);
      const label = (raw.match(/FAIR|FALSE|UNSURE/i) || [""])[0].toUpperCase();
      if (label !== "FAIR" && label !== "FALSE") return null;
      const falseCue = FALSE_CUES.test(said);
      const fairCue = FAIR_CUES.test(said);
      if (label === "FAIR" && falseCue && !fairCue) return null;
      if (label === "FALSE" && fairCue && !falseCue) return null;
      const verdict = label === "FAIR" ? "fair" : "false_alarm";
      return { verdict, factors: verdict === "fair" ? f.map((x) => x.id) : [], reply: FEEDBACK_REPLY[verdict] };
    } catch (err) {
      console.warn("AI couldn't interpret the feedback:", err);
      return null;
    }
  }

  // Sends the verdict to whichever tracker owns this alert's scorer. Resolves
  // {adjusted: string[], duplicate} or null if neither is there.
  async function recordFeedback(alert, valid, factors) {
    const payload = { alertId: alert.id, valid, factors: factors && factors.length ? factors : fired(alert).map((x) => x.id) };
    if (typeof LocalSignals !== "undefined" && LocalSignals.available()) return LocalSignals.recordRiskFeedback(payload);
    if (typeof WebTracker !== "undefined" && WebTracker.available()) return WebTracker.recordRiskFeedback(payload);
    return null;
  }

  // ---- 2b. Words typed on the full-screen check-in's flag page ----
  //
  // The overlay is native and can't run the model, so the person's own words wait in native storage
  // (RiskFeedbackNotes.java) until the app next opens. Then, for each note:
  //   - applied === false: they typed words but picked no reasons, so working out WHICH part of the
  //     nudge they meant is the AI's job: one category word (length / app / time of day / none), see
  //     attributeFactors. Factors in that category get the false-alarm nudge; "none", an unclear answer
  //     or no model means every factor that fired does (the person did flag it as wrong -- only the
  //     "which part" is unknown). Bounded +/-2, once per alert.
  //   - applied === true: the weights were already adjusted when they tapped (they picked reasons, or
  //     skipped); the note is kept only as context.
  // Every note (except one that trips the crisis gate) is also kept, newest few, so later model calls
  // can know what this person has said about the check-ins.

  const NOTES_KEY = "reclaim_feedback_notes";
  const NOTES_KEPT = 5;

  // Measured on the real Pixel 8a (Qwen3.5-2B), 8 realistic explanations, three formulations:
  //   - one YES/NO per factor, with examples: said YES to everything (or NO to everything) every time,
  //     so it never singled anything out -- no better than the fallback;
  //   - one multiple-choice number, zero-shot: answered "none" for 6 of 8;
  //   - ONE category word with category definitions and 8 worked examples (this): 9 of 12 on a fresh,
  //     larger set, and every miss was "none"/unparseable -- never a wrong specific pick. It is also a
  //     single ~5 s call instead of one per factor.
  // Categories map to the factors they cover; anything not clearly one of them falls back to every
  // factor that fired. The result is always a subset of what actually fired.
  const ATTRIBUTE_SYSTEM = `A recovery app sent someone a check-in because it noticed signs. The person said it was a false alarm and explained. Label which sign their explanation says was wrong, with exactly one word:
LENGTH - they say the time spent was short or the session had barely started.
APP - they say the app or site is fine, harmless, or needed (for work, school, or talking to someone).
TIMEOFDAY - they say the time of day was not a problem for them.
NONE - they don't point at any of these in particular.
Examples:
"I just got on a few seconds ago" -> LENGTH
"Only had it open briefly" -> LENGTH
"I use this site for my job" -> APP
"Banking app, nothing wrong with it" -> APP
"Late nights are fine for me lately" -> TIMEOFDAY
"I'm a night owl, that hour is normal" -> TIMEOFDAY
"I was making dinner" -> NONE
"Not sure why it flagged me" -> NONE
Reply with only the one word.`;

  const ATTRIBUTE_GROUPS = {
    LENGTH: ["duration"],
    APP: ["triggerApp", "socialMedia"],
    TIMEOFDAY: ["selfReportedTime", "historicalTime"],
  };

  async function attributeFactors(text, ids) {
    const adjustable = ids.filter((id) => FACTOR_GUIDE[id] && FACTOR_GUIDE[id].adjustable);
    if (!adjustable.length || !(await whenModelReady(30000))) return ids;
    try {
      const raw = await withTimeout(ask(ATTRIBUTE_SYSTEM, text.slice(0, 400), { maxTokens: 6, temperature: 0 }), MODEL_WAIT_MS);
      // The model writes the time label several ways ("TIMEOFDAY", "TIME_OF_DAY", "TIME").
      const m = raw.toUpperCase().replace(/[^A-Z]/g, " ").match(/\b(LENGTH|APP|TIMEOFDAY|TIME|NONE)\b/);
      const label = m ? (m[1] === "TIME" ? "TIMEOFDAY" : m[1]) : "NONE";
      const picked = (ATTRIBUTE_GROUPS[label] || []).filter((id) => adjustable.includes(id));
      return picked.length ? picked : ids;
    } catch (err) {
      console.warn("AI couldn't attribute the feedback:", err);
      return ids;
    }
  }

  function readNotes() {
    try {
      const stored = JSON.parse(localStorage.getItem(NOTES_KEY) || "[]");
      return Array.isArray(stored) ? stored : [];
    } catch (e) {
      return [];
    }
  }

  function keepNote(note, ids) {
    const notes = readNotes();
    notes.push({ at: note.at || Date.now(), app: note.app || "", text: String(note.text).slice(0, 140), about: ids.slice(0, 3).map(labelOf) });
    try {
      localStorage.setItem(NOTES_KEY, JSON.stringify(notes.slice(-NOTES_KEPT)));
    } catch (e) {}
  }

  // One line for the chat model's per-turn context ("what they've told the app about the check-ins"),
  // or "" when there's nothing. Newest two, short, in their own words.
  function feedbackContext() {
    const notes = readNotes().slice(-2);
    if (!notes.length) return "";
    return notes.map((n) => `"${n.text}"${n.about && n.about.length ? ` (about: ${n.about.join(", ").toLowerCase()})` : ""}`).join("; ");
  }

  // A false alarm flagged on the in-app check-in screen (riskAlertView.js), which follows the
  // overlay's flag page (Nathaniel, 2026-10-07: no "was this fair?" question there either). Same
  // rules as processFeedbackNotes, applied at once since the app is open: parts they picked are
  // taken as given; typed words with nothing picked go to attributeFactors; nothing at all (Skip)
  // means every factor that fired. Typed words are kept as chat context. The caller runs the crisis
  // gate on the words first. Resolves recordFeedback's {adjusted, duplicate}, or null.
  async function flagFalseAlarm(alert, { factors = [], text = "" } = {}) {
    const ids = fired(alert).map((f) => f.id);
    const said = String(text || "").trim();
    let used = factors.length ? factors.filter((id) => ids.includes(id)) : ids;
    if (said && !factors.length) used = await attributeFactors(said, ids);
    const outcome = await recordFeedback(alert, false, used);
    if (said) keepNote({ text: said, app: alert.appLabel || "" }, used);
    return outcome;
  }

  // Resolves {processed, attributed}. Never rejects. Called when the app opens / resumes.
  async function processFeedbackNotes() {
    if (typeof LocalSignals === "undefined" || !LocalSignals.available()) return { processed: 0, attributed: 0 };
    let notes = [];
    try {
      notes = await LocalSignals.takePendingFeedbackNotes();
    } catch (e) {
      return { processed: 0, attributed: 0 };
    }
    let attributed = 0;
    for (const note of notes) {
      const text = String((note && note.text) || "").trim();
      const ids = Array.isArray(note.factors) ? note.factors : [];
      if (!text) continue;
      // Their words may be about something much bigger than a false alarm -- the same hard gate chat
      // uses runs first, before any model call. The flag itself still counts (every factor that fired);
      // the note is not kept as model context.
      if (typeof agentIsCrisis === "function" && agentIsCrisis(text)) {
        if (!note.applied && note.alertId) {
          try {
            await LocalSignals.recordRiskFeedback({ alertId: note.alertId, valid: false, factors: ids });
          } catch (e) {}
        }
        const crisisBtn = typeof document !== "undefined" ? document.getElementById("crisisBtn") : null;
        if (crisisBtn) crisisBtn.click();
        continue;
      }
      let used = ids;
      if (!note.applied) {
        used = await attributeFactors(text, ids);
        if (used.length !== ids.length) attributed++;
        try {
          await LocalSignals.recordRiskFeedback({ alertId: note.alertId, valid: false, factors: used });
        } catch (e) {}
      }
      keepNote(note, used);
    }
    return { processed: notes.length, attributed };
  }

  // ---- 2c. Learning from what the person writes elsewhere (check-in notes, chat) ----
  //
  // The flag page is not the only place people tell the app what is hard. A check-in note ("scrolling
  // alone in my room at 1am, bored") and a chat message ("nights are the worst when I'm by myself")
  // describe the SAME things RiskScorer weighs. So the on-device model reads the words and answers with
  // one category word (the format that was reliable on the phone for the flag page); CODE maps the
  // category to factors and applies the usual bounded +2. Signs of difficulty only ever RAISE
  // sensitivity here; nothing a person writes lowers a weight (a note that says things went fine is not
  // evidence the nudge was wrong). Every use is logged (reclaim_learned_from_words) for transparency.

  const LEARN_SYSTEM = `Someone in a recovery app wrote this. Say which situation, if any, they describe as hard for them, with exactly one word:
ALONE - they were by themselves, lonely, or unobserved.
NIGHT - it was late at night or very early morning, or they can't sleep.
LONG - they lost track of time or spent a long time on their phone.
SOCIAL - social media like Instagram, TikTok, Snapchat, YouTube or Reddit.
BORED - boredom or idle time (this app calls the length of a session a factor).
NONE - none of these, or it is a good day.
Examples:
"was scrolling in my room by myself" -> ALONE
"nobody was home and I felt lonely" -> ALONE
"couldn't sleep, it was 2am" -> NIGHT
"nights are the hardest for me" -> NIGHT
"lost track of time on my phone for an hour" -> LONG
"got sucked into Instagram again" -> SOCIAL
"TikTok is my weak spot" -> SOCIAL
"just bored with nothing to do" -> BORED
"had a great day, church and friends" -> NONE
"what time is it in Tokyo" -> NONE
Reply with only the one word.`;

  const LEARN_GROUPS = {
    ALONE: ["alone"],
    NIGHT: ["selfReportedTime", "historicalTime"],
    LONG: ["duration"],
    BORED: ["duration"],
    SOCIAL: ["socialMedia", "triggerApp"],
  };

  const LEARN_LOG_KEY = "reclaim_learned_from_words";
  const LEARN_CHAT_GAP_MS = 6 * 3600 * 1000; // chat is chatty: at most one chat-driven nudge per 6 hours

  function readLearnLog() {
    try {
      const v = JSON.parse(localStorage.getItem(LEARN_LOG_KEY) || "[]");
      return Array.isArray(v) ? v : [];
    } catch (e) {
      return [];
    }
  }

  // One category word -> the factors it covers (a subset of the adjustable ones), or [] for NONE /
  // unparseable / no model. Exposed for tests with a stub model.
  async function categorizeWords(text) {
    if (!text || !(await whenModelReady(MODEL_WAIT_MS))) return { label: "NONE", factors: [] };
    try {
      const raw = await withTimeout(ask(LEARN_SYSTEM, text.slice(0, 400), { maxTokens: 6, temperature: 0 }), MODEL_WAIT_MS);
      const m = raw.toUpperCase().replace(/[^A-Z]/g, " ").match(/\b(ALONE|NIGHT|LONG|SOCIAL|BORED|NONE)\b/);
      const label = m ? m[1] : "NONE";
      return { label, factors: LEARN_GROUPS[label] || [] };
    } catch (err) {
      console.warn("AI couldn't read the note:", err);
      return { label: "NONE", factors: [] };
    }
  }

  // source: "checkin" | "chat". Resolves the factors nudged (possibly []). Never rejects.
  async function learnFromWords(text, source) {
    try {
      const said = String(text || "").trim();
      if (said.length < 8) return [];
      if (typeof agentIsCrisis === "function" && agentIsCrisis(said)) return []; // never mine a crisis message
      if (typeof LocalSignals === "undefined" || !LocalSignals.available()) return [];
      const log = readLearnLog();
      if (source === "chat") {
        const last = log.filter((e) => e.source === "chat").pop();
        if (last && Date.now() - last.at < LEARN_CHAT_GAP_MS) return [];
      }
      const { label, factors } = await categorizeWords(said);
      if (!factors.length) return [];
      await LocalSignals.nudgeWeights(factors, true);
      log.push({ at: Date.now(), source, label, factors, text: said.slice(0, 80) });
      try {
        localStorage.setItem(LEARN_LOG_KEY, JSON.stringify(log.slice(-20)));
      } catch (e) {}
      return factors;
    } catch (e) {
      return [];
    }
  }

  // ---- 3. Notification wording, written ahead of time ----

  // _v2: the first version asked the model to WRITE phrases from an idea, and on a real phone it
  // produced things like "you're waiting for the end" and "you can breathe again in {minutes}
  // minutes" -- unsafe for a lock screen. v2 only lets it REWORD a fixed base phrase (below), checked
  // word-by-word against that phrase. A bank stored under the old key is simply never read again.
  const BANK_KEY = "reclaim_phrase_bank_v3";
  const BANK_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
  const PLACEHOLDERS = /\{(?:app|minutes|time)\}/g;

  // The base phrase for each factor -- the same wording as RiskNotificationText's built-ins. The
  // model rewords it; every placeholder in the base must survive into each reworded line, and each
  // `keep` pattern must still match. The vocabulary check can't see grammar, and on a real phone the
  // model produced "You've spent {minutes} on {app}" (would read "spent 22 on Instagram") and "which
  // flagged as a trigger" -- so the load-bearing wording of each phrase is pinned here instead.
  const BANK_SPECS = [
    { id: "duration", base: "You've been on {app} for {minutes} minutes.", keep: [/\{minutes\} minutes/] },
    { id: "triggerApp", base: "You're on {app}, which you flagged as a trigger.", keep: [/\byou(?:'ve)? flagged\b/, /\btrigger\b/] },
    { id: "socialMedia", base: "You've been scrolling on {app} {time}.", keep: [/\bscroll\w*/] },
    { id: "selfReportedTime", base: "This is a time of day you said is hard.", keep: [/\byou said\b/, /\bhard\b/] },
    { id: "historicalTime", base: "This time of day has been tough for you before.", keep: [/\b(?:tough|hard)\b/, /\bbefore\b/] },
    { id: "alone", base: "It's quiet around you right now.", keep: [/\bquiet\b/, /\baround you\b/] },
    { id: "closer", base: "Let's check in.", keep: [/\bcheck in\b/] },
  ];

  const BANK_SYSTEM = `You reword one short notification line from a caring recovery app. Write exactly 3 different rewordings, one per line, no numbering, no quotes, at most 12 words each. Keep the same meaning and keep any {app}, {minutes} or {time} placeholder exactly as written. Add no new facts, reasons, feelings or advice. Output only the 3 lines.`;

  function validatePhrase(spec, line) {
    const s = line.replace(/^[\s\-*\u2022\d.)"\u201C']+|["\u201D']+\s*$/g, "").trim();
    if (s.length < 10 || s.length > 90) return null;
    if (/[^\x20-\x7E\u2019]/.test(s)) return null; // stray non-ASCII from the model
    if (/\{[^}]*\}/.test(s.replace(PLACEHOLDERS, ""))) return null;
    if (/\d/.test(s)) return null;
    if ((spec.base.match(PLACEHOLDERS) || []).some((p) => !s.includes(p))) return null;
    if (/[.!?]\s+\S/.test(s)) return null; // one sentence only
    if (CLAIMS_DENIED.test(s)) return null;
    const filter = typeof isSafeSentence === "function" ? isSafeSentence : () => true;
    if (!filter(s)) return null;
    if (!vocabOk(s, spec.base)) return null; // a paraphrase of the base, nothing more
    if (spec.keep.some((re) => !re.test(s))) return null; // and still grammatical where it matters
    return /[.!?]$/.test(s) ? s : `${s}.`;
  }

  function getPhraseBank() {
    try {
      const stored = JSON.parse(localStorage.getItem(BANK_KEY) || "null");
      if (!stored || !stored.bank) return {};
      // Re-checked on every read, not just when written: found on a real phone, a bank stored before
      // the validation rules were tightened kept its weaker phrases (e.g. "You've spent {minutes} on
      // {app}") for the full week until its refresh. Whatever no longer passes is simply dropped.
      const clean = {};
      for (const spec of BANK_SPECS) {
        const ok = (stored.bank[spec.id] || []).map((p) => validatePhrase(spec, p)).filter(Boolean);
        if (ok.length) clean[spec.id] = ok;
      }
      return clean;
    } catch (e) {
      return {};
    }
  }

  function bankIsFresh() {
    try {
      const stored = JSON.parse(localStorage.getItem(BANK_KEY) || "null");
      return !!stored && Date.now() - stored.at < BANK_MAX_AGE_MS;
    } catch (e) {
      return false;
    }
  }

  let refreshing = null;

  // Writes (or rewrites, weekly) the phrase templates, one small model call per factor, then
  // mirrors them to the background notifier. Quiet and best-effort: stops at the first failure,
  // keeps whatever was written before, and the notifier has built-in phrases for anything missing.
  // Only worth doing where something posts notifications (Android, or the browser extension).
  function refreshPhraseBank({ force = false } = {}) {
    if (refreshing) return refreshing;
    const nativeOrExt =
      (typeof LocalSignals !== "undefined" && LocalSignals.available()) || (typeof WebTracker !== "undefined" && WebTracker.available());
    if (!nativeOrExt || typeof LocalModel === "undefined" || !LocalModel.isReady() || (!force && bankIsFresh())) return Promise.resolve(false);
    refreshing = (async () => {
      const bank = { ...getPhraseBank() };
      let wrote = 0;
      try {
        for (const spec of BANK_SPECS) {
          const raw = await withTimeout(ask(BANK_SYSTEM, spec.base, { maxTokens: 70, temperature: 0.6 }), MODEL_WAIT_MS);
          const phrases = [...new Set(raw.split("\n").map((l) => validatePhrase(spec, l)).filter(Boolean))].slice(0, 4);
          if (phrases.length) {
            bank[spec.id] = phrases;
            wrote++;
          }
        }
      } catch (err) {
        console.warn("Phrase bank refresh stopped early:", err);
      }
      if (wrote) {
        try {
          localStorage.setItem(BANK_KEY, JSON.stringify({ bank, at: Date.now() }));
        } catch (e) {}
        if (typeof RiskProfile !== "undefined") RiskProfile.syncToNative();
      }
      return wrote > 0;
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  // ---- 3b. The note bank: complete AI-written notes for each combination of reasons ----
  //
  // This is what makes the notification / full-screen text actually AI-written AND specific. The model
  // can't run while the app is closed, so while the app is open it pre-writes a few COMPLETE two-sentence
  // notes for each combination of reasons that can fire, with live slots -- {app}, {minutes}, {time} --
  // which the native notifier (RiskNotificationText.java) / the extension fill with the real values the
  // moment a nudge fires: "You've been on Instagram for 22 minutes late tonight, a hard time of day for
  // you. Take a moment to pause and check in." Same rewrite-and-verify method as the alert note (the
  // model only rewords a sentence the code wrote; every output is checked word-by-word), measured on the
  // real phone with the slots: 12 of 15 passed and every failure was correctly rejected.
  //
  // Signature letters (same in RiskNotificationText.java and extension/lib/notificationText.js):
  //   D duration (names the app too, so it replaces A)   A flagged app / flagged social media
  //   T a hard time of day                               L nobody nearby
  // Keyword nudges never get a note -- they keep their one fixed line.
  const NOTE_SIGS = ["D", "DT", "DL", "DTL", "A", "AT", "AL", "ATL"];
  const NOTE_KEY = "reclaim_note_bank_v1";
  const NOTE_SAMPLES = 3;

  function noteSignature(ids) {
    const fired = new Set(ids);
    if (["recentKeywordSevere", "recentKeyword", "recentKeywordMild"].some((k) => fired.has(k))) return null;
    const d = fired.has("duration");
    const a = fired.has("triggerApp") || fired.has("socialMedia");
    if (!d && !a) return null;
    return (d ? "D" : "A") + (fired.has("selfReportedTime") || fired.has("historicalTime") ? "T" : "") + (fired.has("alone") ? "L" : "");
  }

  // The sentence the model is asked to reword for a signature: facts only, with the live slots.
  function noteBase(sig) {
    const head = sig.startsWith("D") ? "You've been on {app} for {minutes} minutes {time}" : "You're on {app} {time}";
    const tail = (sig.includes("T") ? ", a hard time of day for you" : "") + (sig.includes("L") ? ", and no one else seems to be nearby" : "");
    return `${head}${tail}.`;
  }

  const NOTE_SYSTEM = `You rewrite a short note from a caring recovery app. The app is checking in because it wants the person to pause for a moment. It is NOT a greeting and NOT praise: never wish them a good time or say anything is great. Keep every fact exactly as given, add nothing new (no feelings, reasons, guesses, names or numbers), keep any {app}, {minutes} or {time} placeholder exactly as written, then add one short, gentle sentence inviting them to pause and check in. Two sentences total. Output only the two sentences.`;

  // Returns the cleaned note or null. Checked against the base sentence it was written from.
  function validateNote(sig, raw) {
    const base = noteBase(sig);
    let s = String(raw).replace(/\s*\n+\s*/g, " ").trim();
    if (!s || /[^\x20-\x7E\u2019\u2014]/.test(s)) return null;
    if (!/\bcheck/i.test(s)) s += " Let's check in."; // the model often forgets the invitation; add the fixed one
    if (s.length < 25 || s.length > 200) return null;
    if (/\{[^}]*\}/.test(s.replace(PLACEHOLDERS, ""))) return null;
    if ((base.match(PLACEHOLDERS) || []).some((p) => !s.includes(p))) return null;
    if (/\d/.test(s)) return null;
    const parts = splitSentences(s);
    if (!parts.length || parts.length > 2 || !parts.every(isSafe)) return null;
    if (!vocabOk(s, `${base} ${EXPLAIN_GOAL_WORDS}`)) return null;
    // The vocabulary check can't see structure: on the real phone a note passed that read "...{time}, and a
    // hard time of day for you, no one else seems to be nearby." So it must also OPEN the way its source
    // sentence does ("You've been on {app} for {minutes} minutes {time}" / "You're|You are on {app} {time}")
    // and may not splice a clause on with "and a ...".
    const head = base.split(/[,.]/)[0];
    const heads = [head, head.replace("You're", "You are")];
    if (!heads.some((h) => s.startsWith(h))) return null;
    if (/\band a hard time\b/i.test(s)) return null;
    return s;
  }

  function readNoteBank() {
    try {
      const stored = JSON.parse(localStorage.getItem(NOTE_KEY) || "null");
      return stored && stored.bank ? stored : null;
    } catch (e) {
      return null;
    }
  }

  // Re-validated on every read, like the phrase bank: whatever no longer passes today's rules is dropped.
  function getNoteBank() {
    const stored = readNoteBank();
    if (!stored) return {};
    const clean = {};
    for (const sig of NOTE_SIGS) {
      const ok = [...new Set((stored.bank[sig] || []).map((n) => validateNote(sig, n)).filter(Boolean))];
      if (ok.length) clean[sig] = ok;
    }
    return clean;
  }

  let refreshingNotes = null;

  // Writes (or weekly rewrites) the bank, one small model call per sample, then mirrors it to the
  // background notifier. Best-effort and quiet: stops at the first failure, keeps what it has, and the
  // notifier falls back to per-factor phrases for any combination without a note.
  function refreshNoteBank({ force = false } = {}) {
    if (refreshingNotes) return refreshingNotes;
    const stored = readNoteBank();
    const fresh = !!stored && Date.now() - stored.at < BANK_MAX_AGE_MS;
    const nativeOrExt =
      (typeof LocalSignals !== "undefined" && LocalSignals.available()) || (typeof WebTracker !== "undefined" && WebTracker.available());
    if (!nativeOrExt || typeof LocalModel === "undefined" || !LocalModel.isReady() || (!force && fresh)) return Promise.resolve(false);
    refreshingNotes = (async () => {
      const bank = { ...getNoteBank() };
      let wrote = 0;
      try {
        for (const sig of NOTE_SIGS) {
          const have = new Set(bank[sig] || []);
          for (let i = 0; i < NOTE_SAMPLES; i++) {
            const raw = await withTimeout(ask(NOTE_SYSTEM, `${noteBase(sig)}\n${EXPLAIN_GOAL}`, { maxTokens: 70, temperature: i === 0 ? 0.3 : 0.7 }), MODEL_WAIT_MS);
            const note = validateNote(sig, raw);
            if (note && !have.has(note)) {
              have.add(note);
              wrote++;
              bank[sig] = [...have].slice(0, 4); // kept as each one lands, so a failure part-way loses nothing
            }
          }
        }
      } catch (err) {
        console.warn("Note bank refresh stopped early:", err);
      }
      if (wrote) {
        try {
          localStorage.setItem(NOTE_KEY, JSON.stringify({ bank, at: Date.now() }));
        } catch (e) {}
        if (typeof RiskProfile !== "undefined") RiskProfile.syncToNative();
      }
      return wrote > 0;
    })().finally(() => {
      refreshingNotes = null;
    });
    return refreshingNotes;
  }

  return {
    FACTOR_GUIDE,
    getNoteBank,
    refreshNoteBank,
    noteSignature,
    explain,
    templateSummary,
    numbersFor,
    fired,
    labelOf,
    interpretFeedback,
    recordFeedback,
    flagFalseAlarm,
    getPhraseBank,
    refreshPhraseBank,
    processFeedbackNotes,
    feedbackContext,
    learnFromWords,
    _categorizeWords: categorizeWords,
    _attributeFactors: attributeFactors,
    // exposed for tests
    _validatePhrase: validatePhrase,
    _noteBase: noteBase,
    _validateNote: validateNote,
    _NOTE_SIGS: NOTE_SIGS,
    _grounded: grounded,
    _vocabOk: vocabOk,
    _safeSentences: safeSentences,
    _BANK_SPECS: BANK_SPECS,
  };
})();
