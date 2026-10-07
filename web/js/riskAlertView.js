/**
 * Shows RiskNudgeMonitor's "here's what we noticed" detail once the app is actually open --
 * deliberately never shown in the notification or on the lock screen, see that class's own doc
 * comment for why. Checked once at boot (after DB.init, so UserPreferencesStore/CheckInStore are
 * ready) -- LocalSignals.getPendingRiskAlert() clears the flag on read, so this only ever shows
 * once per alert, not every time the app happens to be reopened afterward.
 *
 * What's shown: an AI-written note (RiskExplainer.explain -- grounded in the scorer's trace, with a
 * deterministic template standing in until/unless the model delivers), the plain-language reasons,
 * a "see the numbers" breakdown of exactly what the scorer did, and the feedback controls: two
 * buttons, or the person's own words which the model turns into a proposed verdict that they
 * confirm before anything changes. The weights themselves are only ever moved by the existing
 * bounded nudge in the native/extension scorer -- see RiskExplainer's header.
 */
const RiskAlertView = (function () {
  // Deliberately slow -- long enough to make "I'm okay" a real choice, not a reflex tap that
  // dismisses this before it's actually been read. The filling bar behind the label (CSS) is what
  // makes the wait read as "counting down" rather than "the button is broken."
  const DISMISS_WAIT_MS = 5000;

  let els = {};
  let dismissTimer = null;
  let current = null; // the alert being shown -- what feedback is about
  let proposal = null; // the model's pending interpretation of what the person typed
  let renderToken = 0; // a late AI note for a previous alert must never overwrite a newer one

  function init() {
    els = {
      overlay: document.getElementById("riskAlertOverlay"),
      appLine: document.getElementById("riskAlertAppLine"),
      reasons: document.getElementById("riskAlertReasons"),
      callCards: document.getElementById("riskAlertCallCards"),
      chat: document.getElementById("riskAlertChat"),
      dismiss: document.getElementById("riskAlertDismiss"),
      dismissFill: document.getElementById("riskAlertDismissFill"),
      note: document.getElementById("riskAlertNote"),
      noteSource: document.getElementById("riskAlertNoteSource"),
      numbers: document.getElementById("riskAlertNumbers"),
      numbersBody: document.getElementById("riskAlertNumbersBody"),
      feedback: document.getElementById("riskAlertFeedback"),
      fair: document.getElementById("riskFeedbackFair"),
      falseAlarm: document.getElementById("riskFeedbackFalse"),
      which: document.getElementById("riskFeedbackWhich"),
      chips: document.getElementById("riskFeedbackChips"),
      falseDone: document.getElementById("riskFeedbackFalseDone"),
      text: document.getElementById("riskFeedbackText"),
      send: document.getElementById("riskFeedbackSend"),
      proposalBox: document.getElementById("riskFeedbackProposal"),
      proposalText: document.getElementById("riskFeedbackProposalText"),
      apply: document.getElementById("riskFeedbackApply"),
      nope: document.getElementById("riskFeedbackNope"),
      result: document.getElementById("riskFeedbackResult"),
    };
    els.fair.addEventListener("click", () => submit(true, null));
    els.falseAlarm.addEventListener("click", showWhich);
    els.falseDone.addEventListener("click", () => submit(false, selectedChips()));
    els.send.addEventListener("click", sendFreeText);
    els.apply.addEventListener("click", () => proposal && submit(proposal.verdict === "fair", proposal.factors));
    els.nope.addEventListener("click", () => {
      proposal = null;
      els.proposalBox.hidden = true;
      els.text.focus();
    });
    els.dismiss.addEventListener("click", close);
    els.chat.addEventListener("click", () => {
      close();
      // No exposed cross-module navigation API -- app.js's showView is private to its own IIFE,
      // same reasoning PreferencesView's "Add one now" button used for the preferences overlay.
      const chatNav = document.querySelector('.nav-item[data-view="chat"]');
      if (chatNav) chatNav.click();
    });
  }

  async function checkPending() {
    if (typeof LocalSignals === "undefined" || !LocalSignals.available()) return;
    const alert = await LocalSignals.getPendingRiskAlert();
    if (!alert) return;
    render(alert);
  }

  function render(alert) {
    current = alert;
    proposal = null;
    els.appLine.textContent = alert.appLabel ? `You were on ${alert.appLabel}.` : "";
    renderNote(alert);
    renderNumbers(alert);
    resetFeedback(alert);

    els.reasons.innerHTML = "";
    (alert.reasons || []).forEach((r) => {
      const li = document.createElement("li");
      li.textContent = r;
      els.reasons.appendChild(li);
    });

    els.callCards.innerHTML = "";
    const prefs = typeof UserPreferencesStore !== "undefined" ? UserPreferencesStore.get() : null;
    if (prefs) {
      [
        { name: prefs.accountability_name, phone: prefs.accountability_phone },
        { name: prefs.accountability_name_2, phone: prefs.accountability_phone_2 },
      ]
        .filter((p) => p.phone)
        .forEach((p) => els.callCards.appendChild(buildCallButton(p)));
    }

    els.overlay.classList.add("visible");
    startDismissCountdown();
  }

  // The deterministic note shows at once (so the screen is never empty or generic), then the
  // on-device AI's version replaces it if the model delivers something that passes every check.
  async function renderNote(alert) {
    const token = ++renderToken;
    els.note.textContent = RiskExplainer.templateSummary(alert);
    els.note.classList.remove("pending");
    els.noteSource.textContent = "";
    if (!alert.trace) return;
    els.noteSource.textContent = "Writing a note for you…";
    const { text, source } = await RiskExplainer.explain(alert);
    if (token !== renderToken) return;
    els.note.textContent = text;
    els.noteSource.textContent = source === "ai" ? "Written by the AI on your device, from the numbers below." : "";
  }

  // "See the numbers": exactly what the scorer did -- every factor with its points, and the ones
  // that didn't fire (greyed), so "why this, and why now" is checkable, not taken on trust.
  function renderNumbers(alert) {
    const n = RiskExplainer.numbersFor(alert);
    els.numbers.hidden = !n;
    els.numbers.open = false;
    els.numbersBody.innerHTML = "";
    if (!n) return;
    const table = document.createElement("table");
    n.rows.forEach((r) => {
      const tr = document.createElement("tr");
      if (!r.fired) tr.className = "miss";
      const label = document.createElement("td");
      label.textContent = r.label;
      label.title = r.detail || "";
      const pts = document.createElement("td");
      pts.className = "pts";
      pts.textContent = r.fired ? (r.points > 0 ? `+${r.points}` : String(r.points)) : "—";
      tr.append(label, pts);
      table.appendChild(tr);
    });
    const total = document.createElement("tr");
    total.className = "total";
    const tl = document.createElement("td");
    tl.textContent = `Total vs. your bar (${n.threshold})`;
    const tp = document.createElement("td");
    tp.className = "pts";
    tp.textContent = String(n.score);
    total.append(tl, tp);
    table.appendChild(total);
    els.numbersBody.appendChild(table);
  }

  // ---- Feedback: buttons, or the person's own words ----

  function resetFeedback(alert) {
    // Needs an alert id and the fired factors (older pending alerts, written before this existed,
    // have neither) -- otherwise there's nothing to attach a verdict to, so don't offer one.
    const ok = !!(alert.id && RiskExplainer.fired(alert).length);
    els.feedback.hidden = !ok;
    els.which.hidden = true;
    els.proposalBox.hidden = true;
    els.result.hidden = true;
    els.text.value = "";
    setFeedbackEnabled(true);
  }

  function setFeedbackEnabled(on) {
    [els.fair, els.falseAlarm, els.falseDone, els.send, els.apply, els.nope, els.text].forEach((el) => (el.disabled = !on));
  }

  function showWhich() {
    els.chips.innerHTML = "";
    RiskExplainer.fired(current)
      .filter((f) => RiskExplainer.FACTOR_GUIDE[f.id] && RiskExplainer.FACTOR_GUIDE[f.id].adjustable)
      .forEach((f) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "tag-chip";
        btn.dataset.id = f.id;
        btn.textContent = RiskExplainer.labelOf(f.id);
        btn.addEventListener("click", () => btn.classList.toggle("selected"));
        els.chips.appendChild(btn);
      });
    els.which.hidden = false;
  }

  function selectedChips() {
    return Array.from(els.chips.querySelectorAll(".selected")).map((b) => b.dataset.id);
  }

  async function sendFreeText() {
    const said = els.text.value.trim();
    if (!said) return;
    // Their words may be about something much bigger than a false alarm -- the same hard gate chat
    // uses runs first, before any model call, and never depends on the model.
    if (typeof agentIsCrisis === "function" && agentIsCrisis(said)) {
      showResult(CRISIS_REPLY);
      const crisisBtn = document.getElementById("crisisBtn");
      if (crisisBtn) crisisBtn.click();
      return;
    }
    els.send.disabled = true;
    els.send.textContent = "Reading what you wrote…";
    const read = await RiskExplainer.interpretFeedback(current, said);
    els.send.disabled = false;
    els.send.textContent = "Tell Reclaim";
    if (!read) {
      showResult("I couldn't tell for sure what you meant — the two buttons above are the surest way to tell me.");
      return;
    }
    proposal = read;
    const which = read.factors.map((id) => RiskExplainer.labelOf(id).toLowerCase());
    const understood =
      read.verdict === "fair"
        ? "So this was a fair nudge."
        : which.length
          ? `So this was a false alarm, and these didn't fit: ${which.join("; ")}.`
          : "So this was a false alarm.";
    els.proposalText.textContent = `${read.reply} ${understood} Is that right?`;
    els.proposalBox.hidden = false;
    els.result.hidden = true;
  }

  function showResult(message) {
    els.result.textContent = message;
    els.result.hidden = false;
  }

  // Applies a verdict (once) and says truthfully what changed.
  async function submit(valid, factors) {
    setFeedbackEnabled(false);
    els.proposalBox.hidden = true;
    els.which.hidden = true;
    let outcome = null;
    try {
      outcome = await RiskExplainer.recordFeedback(current, valid, factors);
    } catch (e) {
      outcome = null;
    }
    if (!outcome) {
      setFeedbackEnabled(true);
      showResult("I couldn't save that just now — please try again.");
      return;
    }
    const names = (outcome.adjusted || []).map((id) => RiskExplainer.labelOf(id).toLowerCase());
    if (outcome.duplicate) showResult("You've already told me about this one.");
    else if (!names.length) showResult("Thanks — noted. (This kind of alert is one I never change, so nothing was adjusted.)");
    else showResult(`Thanks. Next time I'll treat these as ${valid ? "a bit more" : "a bit less"} important: ${names.join("; ")}.`);
  }

  // Same tel: mechanism as the crisis modal/Home's accountability card -- a real anchor click,
  // not a window.location assignment, since that's the one already proven to work here.
  function buildCallButton(partner) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "modal-continue";
    btn.textContent = "Call " + (partner.name || "them");
    btn.onclick = () => {
      const a = document.createElement("a");
      a.href = `tel:${partner.phone.replace(/[^\d+]/g, "")}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    };
    return btn;
  }

  function startDismissCountdown() {
    clearTimeout(dismissTimer);
    els.dismiss.disabled = true;
    // Reset instantly (no transition), then force a reflow before starting the real transition --
    // without the reflow the browser can coalesce the 0%-then-100% into a single jump instead of
    // an actual fill over DISMISS_WAIT_MS, especially on a repeat open where the fill is already mid/full.
    els.dismissFill.style.transition = "none";
    els.dismissFill.style.width = "0%";
    void els.dismissFill.offsetWidth;
    els.dismissFill.style.transition = `width ${DISMISS_WAIT_MS}ms linear`;
    els.dismissFill.style.width = "100%";
    dismissTimer = setTimeout(() => {
      els.dismiss.disabled = false;
    }, DISMISS_WAIT_MS);
  }

  function close() {
    els.overlay.classList.remove("visible");
    clearTimeout(dismissTimer);
  }

  // render is exposed for the web version, where the alert comes from WebTracker.takePending()
  // (app.js) rather than the native bridge checkPending() reads.
  return { init, checkPending, render };
})();
