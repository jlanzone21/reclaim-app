/**
 * Shows RiskNudgeMonitor's "here's what we noticed" detail once the app is actually open --
 * deliberately never shown in the notification or on the lock screen, see that class's own doc
 * comment for why. Checked once at boot (after DB.init, so UserPreferencesStore/CheckInStore are
 * ready) -- LocalSignals.getPendingRiskAlert() clears the flag on read, so this only ever shows
 * once per alert, not every time the app happens to be reopened afterward.
 */
const RiskAlertView = (function () {
  // Deliberately slow -- long enough to make "I'm okay" a real choice, not a reflex tap that
  // dismisses this before it's actually been read. The filling bar behind the label (CSS) is what
  // makes the wait read as "counting down" rather than "the button is broken."
  const DISMISS_WAIT_MS = 5000;

  let els = {};
  let dismissTimer = null;

  function init() {
    els = {
      overlay: document.getElementById("riskAlertOverlay"),
      appLine: document.getElementById("riskAlertAppLine"),
      reasons: document.getElementById("riskAlertReasons"),
      callCards: document.getElementById("riskAlertCallCards"),
      chat: document.getElementById("riskAlertChat"),
      dismiss: document.getElementById("riskAlertDismiss"),
      dismissFill: document.getElementById("riskAlertDismissFill"),
    };
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
    els.appLine.textContent = alert.appLabel ? `You were on ${alert.appLabel}.` : "";

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

  return { init, checkPending };
})();
