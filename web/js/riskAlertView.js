/**
 * Shows RiskNudgeMonitor's "here's what we noticed" detail once the app is actually open --
 * deliberately never shown in the notification or on the lock screen, see that class's own doc
 * comment for why. Checked once at boot (after DB.init, so UserPreferencesStore/CheckInStore are
 * ready) -- LocalSignals.getPendingRiskAlert() clears the flag on read, so this only ever shows
 * once per alert, not every time the app happens to be reopened afterward.
 */
const RiskAlertView = (function () {
  let els = {};

  function init() {
    els = {
      overlay: document.getElementById("riskAlertOverlay"),
      appLine: document.getElementById("riskAlertAppLine"),
      reasons: document.getElementById("riskAlertReasons"),
      call: document.getElementById("riskAlertCall"),
      chat: document.getElementById("riskAlertChat"),
      dismiss: document.getElementById("riskAlertDismiss"),
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

    const prefs = typeof UserPreferencesStore !== "undefined" ? UserPreferencesStore.get() : null;
    if (prefs && prefs.accountability_phone) {
      els.call.hidden = false;
      els.call.textContent = "Call " + (prefs.accountability_name || "them");
      // Same tel: mechanism as the crisis modal/accountability card -- a real anchor click,
      // not a window.location assignment, since that's the one already proven to work here.
      els.call.onclick = () => {
        const a = document.createElement("a");
        a.href = `tel:${prefs.accountability_phone.replace(/[^\d+]/g, "")}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
      };
    } else {
      els.call.hidden = true;
    }

    els.overlay.classList.add("visible");
  }

  function close() {
    els.overlay.classList.remove("visible");
  }

  return { init, checkPending };
})();
