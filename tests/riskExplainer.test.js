// Run: node tests/riskExplainer.test.js
// Loads the real web/js/riskExplainer.js and reclaimAgent.js (for the shared unsafe-sentence filter)
// in a vm with a stubbed on-device model, and checks the three jobs RiskExplainer does: the alert
// note, the free-text feedback reading, and the notification phrase bank. The model is the
// untrusted part, so most of this is "what happens when it says something wrong".
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const plain = (x) => JSON.parse(JSON.stringify(x));
const deepEqual = (a, b, msg) => assert.deepEqual(plain(a), plain(b), msg);
const js = (f) => fs.readFileSync(path.join(__dirname, "..", "web", "js", f), "utf8");

function load({ modelState = "ready", reply = () => "", nativeAvailable = true, notes = [] } = {}) {
  const calls = { model: [], feedback: [], nudges: [], sync: 0, crisisClicks: 0 };
  const store = {};
  const sandbox = {
    console: { log: console.log, warn() {}, error: console.error },
    setTimeout, clearTimeout, Date, Math, JSON, Promise,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => (store[k] = String(v)) },
    LocalModel: {
      isReady: () => modelState === "ready",
      getStatus: () => ({ state: modelState }),
      streamChat: async (messages) => {
        calls.model.push(messages);
        const text = await reply(messages, calls.model.length);
        return { text, raw: text, finishReason: "stop" };
      },
    },
    LocalSignals: {
      available: () => nativeAvailable,
      recordRiskFeedback: async (p) => (calls.feedback.push(p), { adjusted: p.factors.filter((f) => f !== "recentKeywordSevere"), duplicate: false }),
      takePendingFeedbackNotes: async () => notes,
      nudgeWeights: async (factors, increase) => calls.nudges.push({ factors, increase }),
    },
    // the app's crisis gate (agentTools.js) and the crisis button the overlay-feedback path opens
    agentIsCrisis: (t) => /kill myself|end it all|suicid/i.test(t),
    document: { getElementById: (id) => (id === "crisisBtn" ? { click: () => calls.crisisClicks++ } : null) },
    WebTracker: { available: () => false },
    UserPreferencesStore: { get: () => ({ accountability_name: "Sam" }) },
    RiskProfile: { syncToNative: () => calls.sync++ },
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(js("reclaimAgent.js"), ctx, { filename: "reclaimAgent.js" }); // isSafeSentence
  vm.runInContext(js("riskExplainer.js") + "\n;this.RiskExplainer = RiskExplainer;", ctx, { filename: "riskExplainer.js" });
  return { R: sandbox.RiskExplainer, calls, store };
}

const f = (id, fired, points, detail) => ({ id, fired, points, detail: detail || `${id} detail` });
const alert = {
  id: 1700000000000,
  appLabel: "Instagram",
  reasons: [],
  trace: {
    score: 80, threshold: 60, highRisk: false, intensity: "medium", timeBucket: "Night", sessionMinutes: 22,
    factors: [
      f("triggerApp", true, 30, "the foreground app is on the user's trigger list"),
      f("duration", true, 30, "22 minutes in the app so far (reaches the full 30 points at 15 minutes)"),
      f("selfReportedTime", true, 20, "it is currently Night, a time the user listed as tempting"),
      f("alone", false, 0, "no nearby-device scan is available"),
    ],
    adjustments: [{ id: "recentReclaimUse", points: -25, detail: "opened Reclaim 10 minutes ago" }],
  },
};

(async () => {
  // ---- Template (no model) ----
  let { R } = load({ modelState: "available" });
  assert.equal(
    R.templateSummary(alert),
    "You've been on Instagram for 22 minutes, and it's late tonight, a hard time of day for you. Let's check in."
  );
  // Keyword factors never put anything specific in the text.
  const kw = { ...alert, trace: { ...alert.trace, factors: [f("recentKeywordSevere", true, 150)] } };
  assert.match(R.templateSummary(kw), /Something on your screen also caught our attention/);
  assert.ok(!/explicit|porn/i.test(R.templateSummary(kw)));
  // An old alert with no trace still gets a sentence.
  assert.match(R.templateSummary({ appLabel: "Reddit" }), /Reddit/);

  // ---- Numbers view ----
  const n = R.numbersFor(alert);
  assert.equal(n.score, 80);
  deepEqual(n.rows.map((r) => [r.fired, r.points]), [[true, 30], [true, 30], [true, 20], [false, 0], [true, -25]]);
  assert.equal(R.numbersFor({}), null);

  // ---- explain(): the model REWRITES the code's sentence; code verifies the result ----
  const lead = "You've been on Instagram for 22 minutes, and it's late tonight, a hard time of day for you.";
  const good = "You've been on Instagram for 22 minutes, and it's late tonight, which is a hard time of day for you. Let's check in together.";
  let m = load({ reply: () => good });
  deepEqual(await m.R.explain(alert), { text: good, source: "ai" });
  // The model is handed the code-written sentence (not raw scorer internals) and no example output.
  const prompt = m.calls.model[0].map((x) => x.content).join("\n");
  assert.ok(prompt.includes(lead), prompt);
  assert.match(prompt, /gently invite them to pause and check in/, "the purpose is stated");
  assert.ok(!/points|tier|threshold|trigger list|Sam/i.test(prompt), "no scorer internals or partner name in the prompt");
  assert.ok(!prompt.includes("Let's check in together"));
  // Newlines in the reply (the model does this) are fine.
  assert.equal((await load({ reply: () => good.replace(". Let's", ".\nLet's") }).R.explain(alert)).source, "ai");

  const base2 = "You've been on Instagram for 22 minutes, and it's late tonight, which is a hard time of day for you.";
  for (const [why, bad] of [
    ["invented number", "You've been on Instagram for 40 minutes, and it's late tonight. Let's check in."],
    ["dropped the minutes", "You're on Instagram, and it's late tonight. Let's check in."],
    ["dropped the app", "You've been on there for 22 minutes, and it's late tonight. Let's check in."],
    ["invented feeling", base2 + " You're feeling a bit overwhelmed."],
    // seen on the real phone for a bare "You've been on X for N minutes." before the goal line was added:
    ["cheerful greeting", "You've been on Instagram for 22 minutes. I hope you're having a wonderful time."],
    ["praise", "You've been on Instagram for 22 minutes, and it's great to see you using it."],
    ["leaked internals", "You've been on Instagram for 22 minutes with 15 points left. Let's check in."],
    ["invented reason", base2 + " Your brain needs rest. Let's check in."],
    ["stray non-ASCII from the model", base2 + " Take a moment to rest\u6253\u6210"],
    ["claims what was viewed", base2 + " You were watching something. Let's check in."],
    ["relapse claim", "It looks like you slipped on Instagram for 22 minutes, late tonight. Let's check in."],
    ["unsafe sentence (verse offer)", base2 + " Would today's verse help?"],
    ["empty", ""],
  ]) {
    const r = await load({ reply: () => bad }).R.explain(alert);
    assert.equal(r.source, "template", why);
    assert.equal(r.text, load({ modelState: "available" }).R.templateSummary(alert), why);
  }
  // A grounded rewrite that forgot the invitation (the model does this) keeps its facts and gets
  // the template's closing line from code.
  deepEqual(await load({ reply: () => base2 }).R.explain(alert), { text: base2 + " Let's check in.", source: "ai" });
  // the real model's accepted outputs (6/6 once the goal line was added)
  const pauseNote = "You've been on Instagram for 22 minutes, and it's late tonight, a hard time of day for you. Take a moment to pause and check in.";
  deepEqual(await load({ reply: () => pauseNote }).R.explain(alert), { text: pauseNote, source: "ai" });
  deepEqual(await load({ reply: () => base2 + " Please take a moment to check in with yourself." }).R.explain(alert), { text: base2 + " Please take a moment to check in with yourself.", source: "ai" });
  // Anything past the second sentence is ignored (and not checked).
  const long = await load({ reply: () => good + " Something rambling and extra about feelings." }).R.explain(alert);
  deepEqual(long, { text: good, source: "ai" });
  // Keyword alerts stay fixed wording: the model is never asked to talk about them.
  m = load({ reply: () => good });
  const kwAlert = { ...alert, trace: { ...alert.trace, factors: [f("recentKeyword", true, 40), f("duration", true, 30)] } };
  assert.equal((await m.R.explain(kwAlert)).source, "template");
  assert.equal(m.calls.model.length, 0, "no model call for keyword alerts");
  // Model not downloaded / not coming: template, and the model is never called.
  m = load({ modelState: "available", reply: () => good });
  assert.equal((await m.R.explain(alert)).source, "template");
  assert.equal(m.calls.model.length, 0);
  // Model throws: template, no rejection.
  assert.equal((await load({ reply: () => { throw new Error("device lost"); } }).R.explain(alert)).source, "template");
  // Old alert (no trace): template, no model call.
  m = load({ reply: () => good });
  assert.equal((await m.R.explain({ appLabel: "Reddit", reasons: ["x"] })).source, "template");
  assert.equal(m.calls.model.length, 0);

  // ---- interpretFeedback(): the model gives ONE-WORD label; cue words cross-check it ----
  const FAIR_REPLY = "Thanks for telling me — I'll keep an eye out for that.";
  const FALSE_REPLY = "Thanks for telling me — I'll be less quick to flag that.";
  const read = (label, said) => load({ reply: () => label }).R.interpretFeedback(alert, said);
  // Cases from the real-phone run (labels are what Qwen3.5-2B actually returned), with what the app does:
  const fairAll = { verdict: "fair", factors: ["triggerApp", "duration", "selfReportedTime"], reply: FAIR_REPLY };
  const falseAll = { verdict: "false_alarm", factors: [], reply: FALSE_REPLY };
  deepEqual(await read("FALSE", "I was just texting my sister, it wasn't a problem"), falseAll);
  deepEqual(await read("FAIR", "yeah this was fair, I was spiraling"), fairAll);
  deepEqual(await read("FALSE", "it was the afternoon but I was just doing homework"), falseAll);
  deepEqual(await read("FALSE", "no, it wasn't about being on that app, I only opened it to check a message"), falseAll);
  deepEqual(await read("FAIR", "thanks, I needed that"), fairAll);
  deepEqual(await read("FAIR", "I was on there too long honestly"), fairAll);
  // the two real misses: contradicted by the cues / a hedge -> nothing proposed, buttons remain
  assert.equal(await read("FAIR", "this is annoying, stop sending me these"), null, "model said FAIR, cues say complaint");
  assert.equal(await read("FAIR", "maybe"), null, "hedge");
  assert.equal(await read("UNSURE", "lol idk"), null);
  assert.equal(await read("FALSE", "I was on there longer than I wanted"), null, "model said FALSE, cues say fair");
  // Second real-phone run (held-out phrasings, 13/16 before these rules): admissions and no-verdict replies
  assert.equal(await read("FALSE", "I knew I shouldn't have opened it"), null, "admission cue contradicts a FALSE label");
  deepEqual((await read("FAIR", "I knew I shouldn't have opened it")).verdict, "fair");
  deepEqual((await read("FAIR", "That was actually really well timed")).verdict, "fair");
  for (const noVerdict of ["okay", "ok", "what does that mean", "Why did you send this?", "yes", "no", "hmm...", "huh?", "is this about me?"]) {
    m = load({ reply: () => "FAIR" });
    assert.equal(await m.R.interpretFeedback(alert, noVerdict), null, noVerdict);
    assert.equal(m.calls.model.length, 0, "never reaches the model: " + noVerdict);
  }
  // ...but a real answer that merely contains those words still goes through
  deepEqual((await read("FALSE", "no, I was at work")).verdict, "false_alarm");
  deepEqual((await read("FAIR", "yes, I needed that")).verdict, "fair");
  // Both cue families present, or neither: the model's label stands
  deepEqual((await read("FALSE", "it was fair but I was at work")).verdict, "false_alarm");
  // The model's wording is ignored beyond the label; extra words and case don't matter
  deepEqual((await read("  false.\n", "wrong, I was at work")).verdict, "false_alarm");
  for (const junk of ["I think it was fair!", "", "{\"verdict\":\"fair\"}", "DELETE_EVERYTHING", "FAIRLY"]) {
    // "I think it was fair!" / "FAIRLY" contain FAIR -> still just a label; anything without one is null
    const got = await read(junk, "yeah I needed that");
    assert.ok(got === null || got.verdict === "fair", junk);
  }
  assert.equal(await read("", "yeah I needed that"), null);
  // A hedge never even reaches the model
  m = load({ reply: () => "FAIR" });
  await m.R.interpretFeedback(alert, "idk maybe");
  assert.equal(m.calls.model.length, 0);
  // Errors / no model / nothing fired -> null
  assert.equal(await load({ reply: () => { throw new Error("x"); } }).R.interpretFeedback(alert, "yeah I needed that"), null);
  assert.equal(await load({ modelState: "available" }).R.interpretFeedback(alert, "yeah I needed that"), null);
  assert.equal(await load({ reply: () => "FAIR" }).R.interpretFeedback({ ...alert, trace: { ...alert.trace, factors: [] } }, "I needed that"), null, "nothing fired: nothing to give feedback on");
  // The person's text reaches the model clipped, with the labelling instructions as the system prompt
  m = load({ reply: () => "FAIR" });
  await m.R.interpretFeedback(alert, "x".repeat(900) + " needed that");
  assert.ok(m.calls.model[0][1].content.length <= 400);
  assert.match(m.calls.model[0][0].content, /exactly one word/);

  // ---- recordFeedback routes to the bridge; no factors given = everything that fired ----
  m = load({});
  await m.R.recordFeedback(alert, false, []);
  deepEqual(m.calls.feedback[0], { alertId: 1700000000000, valid: false, factors: ["triggerApp", "duration", "selfReportedTime"] });
  assert.equal(await load({ nativeAvailable: false }).R.recordFeedback(alert, true, ["duration"]), null);

  // ---- flagFalseAlarm: the in-app check-in screen's "This was a false alarm", same rules as the
  // overlay's flag page: picked parts as given; typed words alone -> the model's one-word category;
  // Skip -> everything that fired; typed words kept as chat context ----
  m = load({});
  await m.R.flagFalseAlarm(alert, { factors: ["duration", "notARealFactor"] });
  deepEqual(m.calls.feedback[0], { alertId: 1700000000000, valid: false, factors: ["duration"] }, "picked parts, limited to what fired");
  assert.equal(m.calls.model.length, 0, "picked parts need no model call");
  m = load({ reply: () => "LENGTH" });
  await m.R.flagFalseAlarm(alert, { text: "I had only just opened it" });
  deepEqual(m.calls.feedback[0].factors, ["duration"], "words alone: the model picks the part");
  assert.match(m.R.feedbackContext(), /only just opened it/, "the words become chat context");
  m = load({});
  await m.R.flagFalseAlarm(alert, {});
  deepEqual(m.calls.feedback[0].factors, ["triggerApp", "duration", "selfReportedTime"], "Skip: everything that fired");
  assert.equal(m.R.feedbackContext(), "", "no words, no context");

  // ---- Phrase bank: the model may only REWORD a fixed base phrase ----
  const spec = (id) => m.R._BANK_SPECS.find((s) => s.id === id);
  const v = (id, line) => m.R._validatePhrase(spec(id), line);
  const okDur = "It's been {minutes} minutes on {app} now.";
  assert.equal(v("duration", okDur), okDur);
  assert.equal(v("duration", "1. " + okDur), okDur, "a list number prefix is tolerated, then stripped");
  assert.equal(v("duration", "- You've been on {app} for {minutes} minutes"), "You've been on {app} for {minutes} minutes.");
  assert.equal(v("duration", '"' + okDur + '"'), okDur);
  assert.equal(v("duration", "You've been on {app} for 20 minutes."), null, "digits are never allowed");
  assert.equal(v("duration", "It's been a while on {app} now."), null, "must keep the base phrase's placeholders");
  assert.equal(v("duration", "Hey {name}, {minutes} minutes on {app}."), null, "unknown placeholder");
  assert.equal(v("alone", "It's quiet around you. Really quiet."), null, "one sentence only");
  assert.equal(v("alone", "It's quiet around you right now \u6253\u6210"), null, "stray non-ASCII");
  assert.equal(v("alone", "You seem to be watching alone."), null, "claims deny-list");
  assert.equal(v("alone", "Hi"), null, "too short");
  assert.equal(v("alone", "x".repeat(95)), null, "too long");
  assert.equal(v("closer", "Call me anytime, I'm always here."), null, "shared unsafe filter");
  assert.equal(v("closer", "Want to check in for a minute?"), "Want to check in for a minute?");
  // Regressions from the second real-phone run (v2 vocabulary check alone let these through):
  assert.equal(v("duration", "You've spent {minutes} on {app}."), null, "{minutes} must stay next to 'minutes'");
  assert.equal(v("triggerApp", "You are now on {app}, which flagged as a trigger."), null, "ungrammatical");
  assert.equal(v("selfReportedTime", "It's hard for you to take this time of day."), null, "meaning lost");
  assert.equal(v("historicalTime", "This time of day was tough for you."), null, "dropped 'before'");
  assert.equal(v("selfReportedTime", "You are in a time of day you said is hard."), "You are in a time of day you said is hard.");
  assert.equal(v("alone", "It's quiet around you right now."), "It's quiet around you right now.");
  // Regressions: every one of these came out of the real model on a Pixel 8a when it was asked to
  // WRITE phrases (v1), and v1 would have put them on a lock screen. None may validate for ANY factor.
  for (const bad of [
    "{app} is waiting for you, just like it did yesterday.",
    "You can breathe again in {minutes} minutes with the help of {app}.",
    "In this moment, you are not alone; just like {app}, you're waiting for the end.",
    "The {minutes} minutes have passed, but you're doing great.",
    "It's {time} time until we reconnect with you again.",
    "The world is rushing, but {time} is just passing through your hands.",
    "You've been easily lost while {app} showed you {time}.",
    "The hours have felt heavy lately, {app}, and that night looks bright too.",
    "Their silence is just a pause in the long rhythm of your life, and it's okay.",
    "It feels very quiet around them, but that just means {app} is speaking softly now.",
  ]) for (const sp of m.R._BANK_SPECS) assert.equal(m.R._validatePhrase(sp, bad), null, sp.id + ": " + bad);

  // refresh sends the BASE phrase (not an "idea"), keeps only valid rewordings, and syncs
  m = load({
    reply: (messages) => {
      const base = messages[1].content;
      if (base.includes("{minutes}")) return "It's been {minutes} minutes on {app} now.\nYou're {minutes} minutes in on {app}, waiting for the end.\nBad: 5 minutes";
      if (base === "Let's check in.") return "Want to check in?\nWant to take a moment to check in?\nEnding with nothing";
      return "Nothing usable here with {evil}";
    },
  });
  assert.equal(await m.R.refreshPhraseBank(), true);
  const bank = m.R.getPhraseBank();
  deepEqual(bank.duration, ["It's been {minutes} minutes on {app} now."]);
  deepEqual(bank.closer, ["Want to check in?", "Want to take a moment to check in?"]);
  assert.equal(bank.alone, undefined, "no valid line -> no entry (the notifier uses its built-in)");
  assert.ok(m.calls.model.every((c) => c[1].content === m.R._BANK_SPECS.find((s) => s.base === c[1].content).base), "model is given the fixed base phrase");
  assert.ok(!m.calls.model.some((c) => /idea|write/i.test(c[1].content)));
  assert.equal(m.calls.sync, 1);
  // a stored bank is re-validated on read: phrases that fail today's rules vanish (real-phone bug)
  const stale = load({});
  stale.store.reclaim_phrase_bank_v3 = JSON.stringify({ at: Date.now(), bank: {
    duration: ["You've spent {minutes} on {app}.", "It's been {minutes} minutes on {app} now."],
    alone: ["you're waiting for the end"] } });
  deepEqual(stale.R.getPhraseBank(), { duration: ["It's been {minutes} minutes on {app} now."] });
  // the v1 key is never read
  const old = load({});
  old.store.reclaim_phrase_bank = JSON.stringify({ bank: { alone: ["you're waiting for the end"] }, at: Date.now() });
  deepEqual(old.R.getPhraseBank(), {});
  // fresh bank: not rewritten again until forced
  const before = m.calls.model.length;
  assert.equal(await m.R.refreshPhraseBank(), false);
  assert.equal(m.calls.model.length, before);
  assert.equal(await m.R.refreshPhraseBank({ force: true }), true);
  // nothing posts notifications here (plain browser): don't spend model time
  assert.equal(await load({ nativeAvailable: false, reply: () => "x" }).R.refreshPhraseBank(), false);
  // a failure partway keeps what was written and doesn't throw
  let n2 = 0;
  m = load({ reply: () => { if (++n2 > 2) throw new Error("device lost"); return "It's been {minutes} minutes on {app} now.\nYou're on {app}, which you flagged as a trigger."; } });
  assert.equal(await m.R.refreshPhraseBank(), true);
  deepEqual(Object.keys(m.R.getPhraseBank()).sort(), ["duration", "triggerApp"].sort());

  // ---- Words typed on the full-screen check-in's flag page ----
  const fired3 = ["triggerApp", "duration", "selfReportedTime"];
  const note = (over) => ({ alertId: 77, app: "Chrome", text: "I was only on for a minute", factors: fired3, applied: false, at: 1, ...over });
  // The model answers ONE category word for the person's words.
  const label = (word) => () => word;

  // words only (applied:false): the AI picks the category; the false alarm goes to those factors only
  m = load({ notes: [note()], reply: label("LENGTH") });
  deepEqual(await m.R.processFeedbackNotes(), { processed: 1, attributed: 1 });
  deepEqual(m.calls.feedback, [{ alertId: 77, valid: false, factors: ["duration"] }]);
  assert.equal(m.calls.model.length, 1, "a single call, not one per factor");
  assert.equal(m.calls.model[0][1].content, "I was only on for a minute");
  assert.match(m.calls.model[0][0].content, /exactly one word/);
  assert.match(m.calls.model[0][0].content, /"I use this site for my job" -> APP/);
  // and the note is kept as context for the chat model
  assert.equal(m.R.feedbackContext(), '"I was only on for a minute" (about: how long you\'d been there)');
  // categories map to the factors they cover, and only the ones that fired
  const fired4 = ["triggerApp", "socialMedia", "duration", "selfReportedTime", "historicalTime"];
  for (const [word, want] of [["APP", ["triggerApp", "socialMedia"]], ["time_of_day", ["selfReportedTime", "historicalTime"]], ["TIMEOFDAY", ["selfReportedTime", "historicalTime"]], ["Time", ["selfReportedTime", "historicalTime"]], ["LENGTH.", ["duration"]]]) {
    m = load({ notes: [note({ factors: fired4 })], reply: label(word) });
    await m.R.processFeedbackNotes();
    deepEqual(m.calls.feedback[0].factors, want, word);
  }
  m = load({ notes: [note({ factors: ["triggerApp", "duration"] })], reply: label("TIMEOFDAY") });
  await m.R.processFeedbackNotes();
  deepEqual(m.calls.feedback[0].factors, ["triggerApp", "duration"], "category not among what fired -> everything that fired");
  // NONE / garbage / empty -> every factor that fired (they did flag it; only "which part" is unknown)
  for (const reply of ["NONE", "I think it was fine", "", "42", "YES"]) {
    m = load({ notes: [note()], reply: label(reply) });
    assert.equal((await m.R.processFeedbackNotes()).attributed, 0, reply);
    deepEqual(m.calls.feedback[0].factors, fired3, reply);
  }
  // model not downloaded / throws -> every factor that fired, and it never throws
  m = load({ modelState: "available", notes: [note()], reply: label("LENGTH") });
  await m.R.processFeedbackNotes();
  deepEqual(m.calls.feedback[0].factors, fired3);
  assert.equal(m.calls.model.length, 0);
  m = load({ notes: [note()], reply: () => { throw new Error("device lost"); } });
  await m.R.processFeedbackNotes();
  deepEqual(m.calls.feedback[0].factors, fired3);
  // only factors the scorer can tune are ever attributed (the SEVERE keyword tier is fixed)
  m = load({ notes: [note({ factors: ["recentKeywordSevere", "duration"] })], reply: label("LENGTH") });
  await m.R.processFeedbackNotes();
  deepEqual(m.calls.feedback[0].factors, ["duration"]);
  m = load({ notes: [note({ factors: ["recentKeywordSevere"] })], reply: label("LENGTH") });
  await m.R.processFeedbackNotes();
  assert.equal(m.calls.model.length, 0, "nothing tunable fired: the model isn't even asked");
  // already applied at tap time (reasons picked, or skipped): no second adjustment, no model call --
  // the words are only kept as context
  m = load({ notes: [note({ applied: true, text: "it was my homework" })], reply: () => "YES" });
  deepEqual(await m.R.processFeedbackNotes(), { processed: 1, attributed: 0 });
  assert.equal(m.calls.feedback.length, 0);
  assert.equal(m.calls.model.length, 0);
  assert.match(m.R.feedbackContext(), /it was my homework/);
  // crisis gate: no model call, the crisis screen opens, the flag still counts, the words aren't kept
  m = load({ notes: [note({ text: "honestly I want to kill myself" })], reply: () => "YES" });
  await m.R.processFeedbackNotes();
  assert.equal(m.calls.model.length, 0);
  assert.equal(m.calls.crisisClicks, 1);
  deepEqual(m.calls.feedback[0].factors, fired3);
  assert.equal(m.R.feedbackContext(), "");
  // nothing waiting / no native layer / blank words
  deepEqual(await load({ notes: [] }).R.processFeedbackNotes(), { processed: 0, attributed: 0 });
  deepEqual(await load({ nativeAvailable: false, notes: [note()] }).R.processFeedbackNotes(), { processed: 0, attributed: 0 });
  m = load({ notes: [note({ text: "   " })] });
  await m.R.processFeedbackNotes();
  assert.equal(m.calls.feedback.length, 0);
  // context: newest two only, clipped, last five kept in storage
  m = load({ notes: [1, 2, 3, 4, 5, 6, 7].map((i) => note({ alertId: i, applied: true, text: "note " + i + " " + "x".repeat(200) })) });
  await m.R.processFeedbackNotes();
  const ctxLine = m.R.feedbackContext();
  assert.ok(ctxLine.includes("note 6") && ctxLine.includes("note 7") && !ctxLine.includes("note 5"), ctxLine);
  assert.equal(JSON.parse(m.store.reclaim_feedback_notes).length, 5);
  assert.ok(JSON.parse(m.store.reclaim_feedback_notes)[0].text.length <= 140);

  // ---- Note bank: complete AI-written notes per combination of reasons, with live slots ----
  m = load({});
  const sigOf = (...ids) => m.R.noteSignature(ids);
  assert.equal(sigOf("duration"), "D");
  assert.equal(sigOf("triggerApp", "duration"), "D", "duration names the app too, so it replaces A");
  assert.equal(sigOf("triggerApp"), "A");
  assert.equal(sigOf("socialMedia", "selfReportedTime"), "AT");
  assert.equal(sigOf("duration", "historicalTime", "selfReportedTime", "alone"), "DTL");
  assert.equal(sigOf("triggerApp", "alone"), "AL");
  assert.equal(sigOf("selfReportedTime"), null, "no app/duration clause to hang a sentence on");
  assert.equal(sigOf("alone"), null);
  assert.equal(sigOf("duration", "recentKeyword"), null, "keyword nudges keep their fixed line, never an AI note");
  assert.equal(sigOf("triggerApp", "recentKeywordSevere"), null);
  assert.equal(m.R._noteBase("D"), "You've been on {app} for {minutes} minutes {time}.");
  assert.equal(m.R._noteBase("AT"), "You're on {app} {time}, a hard time of day for you.");
  assert.equal(m.R._noteBase("DTL"), "You've been on {app} for {minutes} minutes {time}, a hard time of day for you, and no one else seems to be nearby.");
  assert.equal(m.R._NOTE_SIGS.length, 8);

  const vn = (sig, s) => m.R._validateNote(sig, s);
  // outputs the real model gave on the Pixel 8a (12 of 15 passed; these passed)
  assert.equal(vn("D", "You've been on {app} for {minutes} minutes {time}. Please take a moment to pause and check in."), "You've been on {app} for {minutes} minutes {time}. Please take a moment to pause and check in.");
  // a note may UNDER-claim (drop a fact the base had) but never add one
  assert.ok(vn("DTL", "You've been on {app} for {minutes} minutes {time}, and no one else seems to be nearby. Take a moment to pause and check in."));
  assert.ok(vn("A", "You are on {app} {time}. Please take a moment to pause and check in."));
  assert.equal(vn("AT", "You're on {app} {time}, a hard time of day for you. Take a moment to pause and check in."), "You're on {app} {time}, a hard time of day for you. Take a moment to pause and check in.");
  // ...and the ones that failed on the phone are rejected
  assert.equal(vn("A", "You're on {app} {time}. It's okay to just rest for a moment and check in."), null, "invented advice (rest)");
  assert.equal(vn("DT", "You've been on {app} for {minutes} minutes, and a hard time of day has come. Take a moment to pause and check in."), null, "lost {time}");
  assert.equal(vn("AT", "You're on {app} {time}, a hard time of day for you. It's okay to take a moment to pause and check in with yourself."), null, "'okay' isn't in the allowed vocabulary (a real rejection on the phone)");
  assert.ok(vn("AT", "You're on {app} {time}, a hard time of day for you. Please take a moment to pause and check in with yourself."), "'yourself' is allowed");
  // structure the vocabulary check can't see (real phone: a spliced clause passed it)
  assert.equal(vn("DTL", "You've been on {app} for {minutes} minutes {time}, and a hard time of day for you, no one else seems to be nearby. Take a moment to pause and check in."), null, "spliced clause");
  assert.equal(vn("A", "Right now you're on {app} {time}. Take a moment to pause and check in."), null, "must open like the source sentence");
  assert.ok(vn("D", "You've been on {app} for {minutes} minutes {time}. Please pause to check in."));
  // other rejections
  assert.equal(vn("A", "You're on {app} {time}. Hope you're having a wonderful time. Check in."), null, "3 sentences / cheer");
  assert.equal(vn("A", "You're on {app} for 20 minutes {time}. Take a moment to pause and check in."), null, "digits");
  assert.equal(vn("A", "Hey {name}, you're on {app} {time}. Take a moment to pause and check in."), null, "unknown placeholder");
  assert.equal(vn("D", "You're on {app} {time}. Take a moment to pause and check in."), null, "D needs {minutes}");
  assert.equal(vn("A", "You're on {app} {time}. Take a moment to pause and check in \u6253\u6210."), null, "non-ASCII");
  assert.equal(vn("A", "You're on {app} {time}."), "You're on {app} {time}. Let's check in.", "missing invitation is added, as for the alert note");
  assert.equal(vn("A", "x"), null);

  // refresh: one call per sample, writes only valid notes, mirrors to the notifier, re-validates on read
  const asked = [];
  m = load({
    reply: (messages) => {
      const base = messages[1].content.split("\n")[0];
      asked.push(base);
      return base + " Take a moment to pause and check in.";
    },
  });
  assert.equal(await m.R.refreshNoteBank(), true);
  const nb = m.R.getNoteBank();
  deepEqual(Object.keys(nb).sort(), m.R._NOTE_SIGS.slice().sort());
  assert.equal(nb.D[0], "You've been on {app} for {minutes} minutes {time}. Take a moment to pause and check in.");
  assert.equal(nb.D.length, 1, "identical samples are stored once");
  assert.equal(m.calls.sync, 1);
  assert.equal(asked.length, 8 * 3, "3 samples per combination");
  assert.match(m.calls.model[0][1].content, /\(Goal: gently invite them to pause and check in\.\)/);
  assert.equal(await m.R.refreshNoteBank(), false, "fresh bank: not rewritten until forced");
  assert.equal(await load({ nativeAvailable: false, reply: () => "x" }).R.refreshNoteBank(), false);
  // a stored bank is re-validated on read
  const staleNotes = load({});
  staleNotes.store.reclaim_note_bank_v1 = JSON.stringify({ at: Date.now(), bank: { D: ["You've been on {app} for {minutes} minutes {time}. Rest and breathe.", "You've been on {app} for {minutes} minutes {time}. Take a moment to pause and check in."], A: ["you're waiting for the end"] } });
  deepEqual(staleNotes.R.getNoteBank(), { D: ["You've been on {app} for {minutes} minutes {time}. Take a moment to pause and check in."] });
  // failure partway keeps what was written
  let calls3 = 0;
  m = load({ reply: (msgs) => { if (++calls3 > 4) throw new Error("device lost"); return msgs[1].content.split("\n")[0] + " Take a moment to pause and check in."; } });
  assert.equal(await m.R.refreshNoteBank(), true);
  deepEqual(Object.keys(m.R.getNoteBank()).sort(), ["D", "DT"]);

  // ---- learning from the person's own words (check-in notes, chat) ----
  m = load({ reply: () => "ALONE" });
  deepEqual(await m.R.learnFromWords("scrolling in my room by myself again", "checkin"), ["alone"]);
  deepEqual(m.calls.nudges, [{ factors: ["alone"], increase: true }]);
  m = load({ reply: () => "TIME_OF_DAY? no -- NIGHT." });
  deepEqual(await m.R.learnFromWords("couldn't sleep, it was 2am", "checkin"), ["selfReportedTime", "historicalTime"]);
  m = load({ reply: () => "NONE" });
  deepEqual(await m.R.learnFromWords("had a great day with friends", "checkin"), []);
  assert.equal(m.calls.nudges.length, 0, "NONE changes nothing");
  m = load({ reply: () => "I think they feel sad." });
  deepEqual(await m.R.learnFromWords("not sure what to say here honestly", "chat"), [], "an unparseable answer changes nothing");
  m = load({ reply: () => "ALONE" });
  deepEqual(await m.R.learnFromWords("kill myself", "checkin"), [], "crisis words are never mined");
  assert.equal(m.calls.model.length, 0, "...and the model is never even asked");
  deepEqual(await m.R.learnFromWords("hi", "chat"), [], "too short to read");
  m = load({ modelState: "idle", reply: () => "ALONE" });
  deepEqual(await m.R.learnFromWords("scrolling in my room by myself again", "chat"), [], "no model, no learning");
  // chat is rate limited to one nudge per 6 hours; check-in notes are not
  m = load({ reply: () => "SOCIAL" });
  deepEqual(await m.R.learnFromWords("got sucked into Instagram again tonight", "chat"), ["socialMedia", "triggerApp"]);
  deepEqual(await m.R.learnFromWords("TikTok is my weak spot honestly", "chat"), [], "second chat message within 6 hours");
  deepEqual(await m.R.learnFromWords("got sucked into Instagram again tonight", "checkin"), ["socialMedia", "triggerApp"]);
  assert.equal(m.calls.nudges.length, 2);
  assert.equal(JSON.parse(m.store.reclaim_learned_from_words).length, 2, "each use is logged");

  console.log("risk explainer tests passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
