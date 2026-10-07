/**
 * Lectio Divina: a 2-minute, full-screen scripture meditation (Nathaniel, 2026-10-07). "The goal is to
 * interrupt the user in times of temptation and really draw them into God's word and away from the
 * temptation." Opened two ways:
 *   - by a risk nudge: the browser extension's notification, or Android's overlay button / fallback
 *     notification, offers "Pray through <passage>" -- a daily passage the on-device AI picked for the
 *     situation (PassageBank). Opening the app from it lands here (app.js).
 *   - by choice, from Home's "Today's Passage" card ("Pray through it · 2 min").
 *
 * The four movements Guigo II described, 30 seconds each, advancing on their own (decided: no skipping
 * ahead -- staying for the full two minutes is the point; "End" is the only control). Each step narrows in:
 *   1. Lectio (Read)          the whole passage; the person taps the word or phrase that catches them
 *   2. Meditatio (Meditate)   only that phrase, large (no tap -> the first verse)
 *   3. Oratio (Pray)          the phrase, smaller, with a prompt to pray honestly
 *   4. Contemplatio (Rest)    an almost empty screen -- just the reference
 * A soft chime and a short buzz mark each move (eyes may be closed in Contemplatio). Then a closing screen:
 * Call <partner>, Find resources, Done, "This helped / Not for me" (teaches PassageBank which passages help
 * in which situations), and -- after a nudge -- the small "This was a false alarm" link.
 *
 * First the passage's reference and one-line description, with a Begin button. The text comes from YouVersion
 * (with the copyright attribution it requires); offline or on an API error the screen keeps the passage's
 * reference and the person reads it from their own Bible (NIV text can't be bundled) -- only with no passage
 * named at all does it fall back to a bundled verse. A small "In crisis? Get help"
 * link stays on screen the whole time (the crisis resources are never more than a tap away).
 */
const LectioView = (function () {
  const STEP_MS = 30000;
  const LOAD_TIMEOUT_MS = 8000;
  const STEPS = [
    { name: "Lectio", verb: "Read", text: "Read the passage slowly, out loud if you can, and then once more. Tap the word or phrase that catches your attention." },
    { name: "Meditatio", verb: "Meditate", text: "Stay with these words. Repeat them slowly and let them sink in. There's nothing to figure out." },
    { name: "Oratio", verb: "Pray", text: "Tell God honestly what these words stir in you: what you want, what you're fighting, what you're thankful for." },
    { name: "Contemplatio", verb: "Rest", text: "Let go of words and thoughts. Simply rest in God's loving presence." },
  ];

  let els = {};
  let hooks = {};
  let stepMs = STEP_MS;
  let s = null; // the open session
  let token = 0; // a late passage load for an earlier session must never land on a newer one
  let ticker = null;
  let wakeLock = null;
  let audio = null;

  function init(options = {}) {
    hooks = options;
    els = {
      root: document.getElementById("lectioView"),
      progress: Array.from(document.querySelectorAll("#lectioProgress i")),
      count: document.getElementById("lectioCount"),
      end: document.getElementById("lectioEnd"),
      stage: document.getElementById("lectioStage"),
      kicker: document.getElementById("lectioKicker"),
      instruction: document.getElementById("lectioInstruction"),
      body: document.getElementById("lectioBody"),
      closing: document.getElementById("lectioClosing"),
      crisis: document.getElementById("lectioCrisis"),
    };
    els.end.addEventListener("click", () => finish(false));
    els.crisis.addEventListener("click", () => hooks.onCrisis && hooks.onCrisis());
    // Any tap counts as the user gesture browsers need before sound can play (opened from a notification,
    // there was none yet).
    els.root.addEventListener("pointerdown", unlockAudio);
    // A hidden tab/backgrounded app pauses the clock, so nobody comes back to find steps skipped.
    document.addEventListener("visibilitychange", () => {
      if (!s || !s.startedAt || s.done) return;
      if (document.hidden) pause();
      else {
        resume();
        acquireWakeLock();
      }
    });
  }

  /**
   * @param {object} o
   * @param {string} [o.reference]    a daily passage, e.g. "Romans 8:31-39"
   * @param {string} [o.description]  its one-line description (not shown here; kept for feedback)
   * @param {object} [o.verse]        { title, body } -- a bundled verse to use instead (Home's offline fallback)
   * @param {object} [o.alert]        the nudge this came from (false-alarm link, high-risk ordering)
   * @param {object} [o.situation]    { sig, bucket } of that nudge, for PassageBank's outcomes
   * @param {string} [o.source]       "home" | "nudge"
   */
  async function open(o = {}) {
    if (!els.root) return;
    if (s) teardown();
    const my = ++token;
    unlockAudio(); // opened from a tap on Home: that tap is the gesture
    s = { ...o, fromNudge: o.source === "nudge", verses: null, offline: false, picked: [], step: -1, done: false, elapsed: 0, startedAt: 0, rated: false };
    els.root.hidden = false;
    els.closing.hidden = true;
    els.stage.hidden = false;
    document.body.classList.add("lectio-open");
    setProgress(-1, 0);
    els.count.textContent = "";
    els.kicker.textContent = "";
    els.instruction.textContent = "";
    els.body.replaceChildren(line("lectio-loading", o.reference ? `Opening ${o.reference}…` : "Opening the passage…"));
    if (o.source === "home" && o.reference && typeof DailyPassage !== "undefined") {
      // Prayed through today -- a nudge later today offers a different passage (synced to the notifiers).
      DailyPassage.markUsed(o.reference);
      if (typeof RiskProfile !== "undefined") RiskProfile.syncToNative();
    }
    const text = await loadPassage(o);
    if (my !== token || !s) return;
    if (!text) {
      els.body.replaceChildren(line("lectio-loading", "The passage couldn't be opened right now."));
      return;
    }
    Object.assign(s, text);
    acquireWakeLock();
    showIntro();
  }

  // Before step 1: the passage's reference and one-line description, and a Begin button -- the clock only
  // starts when they're ready (Nathaniel, 2026-10-07: an 8-second pause here "feels rushed"). Not one of
  // the four steps, so not on the bars. The tap also lets the chime play (browsers need a gesture first).
  function showIntro() {
    s.step = -1;
    els.root.dataset.step = "intro";
    els.count.textContent = "";
    els.kicker.textContent = s.fromNudge ? "A passage for right now" : "Today's passage";
    els.instruction.textContent = "Take a slow breath. Begin when you're ready.";
    const nodes = [line("lectio-intro-ref", s.reference)];
    if (s.description) nodes.push(line("lectio-intro-desc", s.description));
    const begin = button("Begin", true, () => {
      if (!s || s.step !== -1) return;
      chime(false);
      goTo(0);
    });
    begin.classList.add("lectio-begin");
    nodes.push(begin);
    els.body.replaceChildren(...nodes);
    setProgress(-1, 0);
    clearInterval(ticker);
  }

  // ---- The passage ----

  async function loadPassage(o) {
    if (o.reference && typeof YouVersion !== "undefined" && YouVersion.available()) {
      try {
        const d = await Promise.race([YouVersion.getVerse(o.reference), new Promise((r) => setTimeout(() => r(null), LOAD_TIMEOUT_MS))]);
        const verses = d ? parseVerses(d.html) : [];
        if (verses.length) {
          const abbr = d.version && (d.version.localized_abbreviation || d.version.abbreviation);
          return {
            reference: d.reference || o.reference,
            verses,
            version: abbr || "",
            attribution: d.attribution && d.attribution.text ? d.attribution.text.replace(/\s+/g, " ").trim() : "",
            containerAttributes: d.containerAttributes || null,
            fromYouVersion: true,
          };
        }
      } catch (e) {}
    }
    // Offline, no key, or an API error, with a passage named: still that passage -- its reference, and the
    // person reads it from their own Bible or Bible app (Nathaniel, 2026-10-07: "it should still show the
    // reference and point them to it"). NIV text can't be bundled.
    if (o.reference) return { reference: o.reference, verses: null, offline: true, version: "", attribution: "", fromYouVersion: false };
    // No passage at all: a bundled verse, so the meditation still happens.
    const v = o.verse || (typeof ResourceRepo !== "undefined" ? ResourceRepo.getScripture() : null);
    if (!v || !v.body) return null;
    return { reference: v.title, verses: [{ num: null, text: v.body }], version: "", attribution: "", fromYouVersion: false };
  }

  // YouVersion's passage HTML -> [{ num, text }]. Its verses are <span class="yv-v" v="31"> with the
  // number in a <span class="yv-vlbl">; a poetic verse can be split across lines (same v twice), so those
  // are joined. Only text is taken (textContent), never markup.
  function parseVerses(html) {
    if (!html) return [];
    const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
    const out = [];
    const spans = doc.querySelectorAll(".yv-v");
    if (!spans.length) {
      const text = clean(doc.body.textContent);
      return text ? [{ num: null, text }] : [];
    }
    spans.forEach((span) => {
      const copy = span.cloneNode(true);
      copy.querySelectorAll(".yv-vlbl, sup, .yv-n, .note, .fn").forEach((n) => n.remove());
      const text = clean(copy.textContent);
      if (!text) return;
      const num = span.getAttribute("v");
      const last = out[out.length - 1];
      if (last && last.num === num) last.text = `${last.text} ${text}`;
      else out.push({ num, text });
    });
    return out;
  }

  function clean(t) {
    return String(t || "").replace(/\s+/g, " ").trim();
  }

  // A verse in tappable phrases, split after sentence/clause punctuation (. ? ! ; :) and the em dash --
  // commas stay inside, so "If God is for us, who can be against us?" is one phrase.
  function phrasesOf(text) {
    const out = [];
    const re = /[^.?!;:—]+(?:[.?!;:—]+[”’"')\]]*|$)/g;
    let m;
    while ((m = re.exec(text))) {
      const p = m[0].trim();
      if (p) out.push(p);
    }
    return out.length ? out : [text];
  }

  // ---- Steps ----

  function goTo(step) {
    s.step = step;
    s.elapsed = 0;
    s.startedAt = Date.now();
    const def = STEPS[step];
    els.root.dataset.step = String(step + 1);
    els.count.textContent = `${step + 1} of ${STEPS.length}`;
    els.kicker.textContent = `${def.name} · ${def.verb}`;
    els.instruction.textContent = s.offline && OFFLINE_TEXT[step] ? OFFLINE_TEXT[step] : def.text;
    if (step === 3) renderRest();
    else if (s.offline) renderOffline(step);
    else if (step === 0) renderPassage();
    else renderPhrase(step === 1 ? "lectio-phrase-large" : "lectio-phrase-small");
    setProgress(step, 0);
    clearInterval(ticker);
    ticker = setInterval(tick, 200);
  }

  function tick() {
    if (!s || s.paused) return;
    const elapsed = s.elapsed + (Date.now() - s.startedAt);
    setProgress(s.step, Math.min(1, elapsed / stepMs));
    if (elapsed < stepMs) return;
    if (s.step < STEPS.length - 1) {
      chime(false);
      goTo(s.step + 1);
    } else {
      chime(true);
      finish(true);
    }
  }

  function pause() {
    if (!s || s.paused) return;
    s.elapsed += Date.now() - s.startedAt;
    s.paused = true;
  }

  function resume() {
    if (!s || !s.paused) return;
    s.paused = false;
    s.startedAt = Date.now();
  }

  function setProgress(step, fraction) {
    els.progress.forEach((bar, i) => {
      bar.style.width = i < step ? "100%" : i === step ? `${Math.round(fraction * 1000) / 10}%` : "0%";
    });
  }

  function renderPassage() {
    const box = document.createElement("div");
    box.className = "lectio-passage";
    // Inside YouVersion's container attributes, as its license asks for its text (youversion.js render()).
    if (s.containerAttributes) for (const [k, v] of Object.entries(s.containerAttributes)) box.setAttribute(k, v);
    s.verses.forEach((verse, vi) => {
      if (verse.num) {
        const n = document.createElement("sup");
        n.className = "lectio-vnum";
        n.textContent = verse.num;
        box.appendChild(n);
      }
      phrasesOf(verse.text).forEach((p, pi) => {
        const span = document.createElement("span");
        span.className = "lectio-tap";
        span.setAttribute("role", "button");
        span.tabIndex = 0;
        span.textContent = p;
        const id = `${vi}:${pi}`;
        if (s.picked.some((x) => x.id === id)) span.classList.add("picked");
        const toggle = () => {
          const at = s.picked.findIndex((x) => x.id === id);
          if (at >= 0) s.picked.splice(at, 1);
          else s.picked.push({ id, vi, pi, text: p, num: verse.num });
          span.classList.toggle("picked", at < 0);
          span.setAttribute("aria-pressed", String(at < 0));
        };
        span.addEventListener("click", toggle);
        span.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        });
        box.append(span, document.createTextNode(" "));
      });
    });
    els.body.replaceChildren(box, line("lectio-ref", s.version ? `${s.reference} · ${s.version}` : s.reference), attributionLine());
  }

  // The phrase(s) they tapped, in reading order: neighbours run together, gaps get an ellipsis. Nothing
  // tapped -> the passage's first verse.
  function chosenText() {
    if (!s.verses) return null; // offline: the words are in their own Bible
    if (!s.picked.length) return s.verses[0].text;
    const sorted = s.picked.slice().sort((a, b) => a.vi - b.vi || a.pi - b.pi);
    let out = "";
    sorted.forEach((x, i) => {
      const prev = sorted[i - 1];
      const adjacent = prev && prev.vi === x.vi && prev.pi === x.pi - 1;
      // A phrase split at an em dash ("for us all—") runs straight into the next one.
      out += i === 0 ? x.text : adjacent ? `${/—$/.test(prev.text) ? "" : " "}${x.text}` : ` … ${x.text}`;
    });
    return out;
  }

  // "Romans 8:31-39" + the verse numbers the phrase came from -> "Romans 8:31" / "Romans 8:31-32" / "Romans 8:31, 34".
  function chosenReference() {
    if (!s.verses) return s.reference;
    const nums = [...new Set((s.picked.length ? s.picked.map((x) => x.num) : [s.verses[0].num]).filter(Boolean).map(Number))].sort((a, b) => a - b);
    const m = /^(.*\d)\s*:\s*\d+/.exec(s.reference || "");
    if (!m || !nums.length) return s.reference;
    const contiguous = nums.every((n, i) => i === 0 || n === nums[i - 1] + 1);
    const verses = nums.length === 1 ? `${nums[0]}` : contiguous ? `${nums[0]}-${nums[nums.length - 1]}` : nums.join(", ");
    return `${m[1]}:${verses}`;
  }

  // Offline: the text couldn't be loaded, so the person reads the passage from their own Bible -- the
  // screen holds the reference, and the steps point back to "the words that caught you".
  const OFFLINE_TEXT = {
    0: "Open your Bible or Bible app to this passage. Read it slowly, out loud if you can, and then once more, until a word or phrase catches your attention.",
    1: "Stay with the words that caught you. Repeat them slowly and let them sink in. There's nothing to figure out.",
  };

  function renderOffline(step) {
    if (step === 0) {
      els.body.replaceChildren(line("lectio-phrase lectio-phrase-large", s.reference), line("lectio-offline-note", "The text couldn't be loaded right now, so read it from your own Bible."));
    } else {
      els.body.replaceChildren(line("lectio-phrase lectio-phrase-small", s.reference));
    }
  }

  function renderPhrase(cls) {
    els.body.replaceChildren(line(`lectio-phrase ${cls}`, chosenText()), line("lectio-ref", chosenReference()));
  }

  function renderRest() {
    els.body.replaceChildren(line("lectio-rest-ref", chosenReference()), line("lectio-rest", "Rest. No words needed."));
  }

  function attributionLine() {
    if (!s.fromYouVersion) return document.createTextNode("");
    const a = line("lectio-attribution", s.attribution);
    const via = document.createElement("span");
    via.textContent = " Provided by YouVersion.";
    a.appendChild(via);
    return a;
  }

  function line(className, text) {
    const el = document.createElement("div");
    el.className = className;
    el.textContent = text;
    return el;
  }

  // ---- Closing screen ----

  function finish(completed) {
    if (!s || s.done) return;
    clearInterval(ticker);
    s.done = true;
    releaseWakeLock();
    els.root.dataset.step = "done";
    els.stage.hidden = true;
    setProgress(STEPS.length, 0);
    els.count.textContent = "";
    els.closing.replaceChildren(...closingContent(completed));
    els.closing.hidden = false;
  }

  function closingContent(completed) {
    const nodes = [];
    const meditated = s.step >= 0;
    nodes.push(line("lectio-amen", completed ? "Amen." : "Come back to it anytime."));
    // The words they sat with, to carry out with them (what Meditatio showed: their phrase, or the first verse).
    if ((s.step >= 1 || s.picked.length) && chosenText()) {
      nodes.push(line("lectio-carry", `“${chosenText()}”`), line("lectio-ref", chosenReference()));
    }
    if (meditated) nodes.push(rateRow());

    const actions = document.createElement("div");
    actions.className = "lectio-actions";
    const highRisk = isHighRisk(s.alert);
    const partners = partnerList();
    partners.forEach((p) => actions.appendChild(button(`Call ${p.name || "your partner"}`, highRisk, () => call(p))));
    actions.appendChild(button("Find resources", false, () => {
      close();
      if (hooks.onFindResources) hooks.onFindResources();
    }));
    actions.appendChild(button("Done", !highRisk || !partners.length, close));
    nodes.push(actions);

    // After a nudge: the false-alarm flag (the check-in screen's own flag page, RiskAlertView.openFlag).
    if (s.alert && s.alert.id && typeof RiskExplainer !== "undefined" && RiskExplainer.fired(s.alert).length && typeof RiskAlertView !== "undefined") {
      const alert = s.alert;
      const flag = document.createElement("button");
      flag.type = "button";
      flag.className = "lectio-flag";
      flag.textContent = "This was a false alarm";
      flag.addEventListener("click", () => {
        close();
        RiskAlertView.openFlag(alert);
      });
      nodes.push(flag);
    }
    return nodes;
  }

  // "This helped" / "Not for me": an ordinary thumbs rating on the passage (so the app's other picking
  // learns too) and an outcome tied to the nudge's situation (so PassageBank ranks it up/down there).
  function rateRow() {
    const row = document.createElement("div");
    row.className = "lectio-rate";
    const rate = (rating) => {
      if (s.rated) return;
      s.rated = true;
      recordRating(rating);
      row.replaceChildren(line("lectio-rate-thanks", "Thanks — I'll remember that."));
    };
    const helped = document.createElement("button");
    helped.type = "button";
    helped.textContent = "This helped";
    helped.addEventListener("click", () => rate(1));
    const notForMe = document.createElement("button");
    notForMe.type = "button";
    notForMe.textContent = "Not for me";
    notForMe.addEventListener("click", () => rate(-1));
    const dot = document.createElement("span");
    dot.textContent = " · ";
    row.append(helped, dot, notForMe);
    return row;
  }

  function recordRating(rating) {
    const ref = s.reference;
    const description = s.description || "";
    try {
      const entry = ResourceFeedback.describe("scripture_search", { title: ref, body: description, tags: [] });
      ResourceFeedback.rate(null, entry, rating);
      if (typeof LocalEmbedder !== "undefined") LocalEmbedder.rememberItem(entry.key, description ? `${ref}. ${description}` : ref);
      if (typeof LearnedView !== "undefined") LearnedView.refresh();
    } catch (e) {}
    // Only daily passages are ranked; a bundled fallback verse just gets the thumbs above.
    if (typeof PassageBank !== "undefined" && typeof DailyPassage !== "undefined" && DailyPassage.byRef(ref)) {
      const sit = s.situation || {};
      PassageBank.recordOutcome({ ref, sig: sit.sig || "", bucket: sit.bucket || "", rating });
      PassageBank.refresh({ force: true });
    }
  }

  // High risk (score well past the bar, or something on screen): the partner call goes first, as on the
  // nudge itself (Nathaniel, 2026-10-07: "partner first on high-risk").
  function isHighRisk(alert) {
    if (!alert || !alert.trace) return false;
    if (alert.trace.highRisk) return true;
    try {
      return RiskExplainer.fired(alert).some((f) => f.id === "recentKeywordSevere" || f.id === "recentKeyword");
    } catch (e) {
      return false;
    }
  }

  function partnerList() {
    const prefs = typeof UserPreferencesStore !== "undefined" ? UserPreferencesStore.get() : null;
    if (!prefs) return [];
    return [
      { name: prefs.accountability_name, phone: prefs.accountability_phone },
      { name: prefs.accountability_name_2, phone: prefs.accountability_phone_2 },
    ].filter((p) => p.phone);
  }

  // Same tel: mechanism as the check-in screen's call buttons (a real anchor click).
  function call(partner) {
    const a = document.createElement("a");
    a.href = `tel:${String(partner.phone).replace(/[^\d+]/g, "")}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function button(label, primary, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = primary ? "lectio-btn primary" : "lectio-btn";
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  }

  // ---- Sound, buzz, screen ----

  function unlockAudio() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!audio) audio = new AC();
      if (audio.state === "suspended") audio.resume().catch(() => {});
    } catch (e) {}
  }

  // A soft bell: a low tone with two quiet overtones, fading over ~3 s. Plays at media volume (on Android the
  // ringer switch doesn't silence media). Plus a short buzz where the device has one.
  function chime(final) {
    try {
      unlockAudio();
      if (audio && audio.state === "running") {
        const t0 = audio.currentTime + 0.02;
        [[392, 0.07], [784, 0.02], [1176, 0.01]].forEach(([freq, peak]) => {
          const osc = audio.createOscillator();
          const gain = audio.createGain();
          osc.type = "sine";
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.0001, t0);
          gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.03);
          gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 3);
          osc.connect(gain).connect(audio.destination);
          osc.start(t0);
          osc.stop(t0 + 3.1);
        });
      }
    } catch (e) {}
    try {
      if (navigator.vibrate) navigator.vibrate(final ? [70, 110, 70] : 70);
    } catch (e) {}
  }

  async function acquireWakeLock() {
    try {
      if (navigator.wakeLock && !wakeLock) {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => (wakeLock = null));
      }
    } catch (e) {
      wakeLock = null;
    }
  }

  function releaseWakeLock() {
    try {
      if (wakeLock) wakeLock.release();
    } catch (e) {}
    wakeLock = null;
  }

  // ---- Closing ----

  function teardown() {
    clearInterval(ticker);
    ticker = null;
    releaseWakeLock();
    s = null;
    token++;
  }

  function close() {
    teardown();
    if (!els.root) return;
    els.root.hidden = true;
    delete els.root.dataset.step;
    document.body.classList.remove("lectio-open");
  }

  function isOpen() {
    return !!s;
  }

  return {
    init,
    open,
    close,
    isOpen,
    // exposed for tests
    _parseVerses: parseVerses,
    _phrasesOf: phrasesOf,
    _setStepMs: (ms) => (stepMs = ms || STEP_MS),
  };
})();
