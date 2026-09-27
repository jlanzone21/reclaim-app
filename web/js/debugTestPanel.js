/**
 * TEMPORARY -- a Privacy-tab panel (deliberately loud/dashed-amber styling, see .debug-panel in
 * styles.css) for verifying background features while building them, instead of waiting on real
 * conditions or the ~15-minute periodic schedule, or hand-triggering things over adb/CDP the way
 * this session did before this existed. Not something a real user should ever see.
 *
 * Remove this file, its script tag and markup in index.html, its CSS in styles.css, the debug*
 * wrapper methods in localSignals.js, and the matching TEMPORARY block in
 * LocalSignalsPlugin.java/RiskNudgeMonitor.java together, before shipping this to a real user.
 * See PURPOSE.md.
 */
const DebugTestPanel = (function () {
  let els = {};

  function init() {
    els = {
      panel: document.getElementById("debugTestPanel"),
      runBackground: document.getElementById("debugRunBackgroundCheckBtn"),
      sendNudge: document.getElementById("debugSendRiskNudgeBtn"),
      sendNightly: document.getElementById("debugSendNightlyBtn"),
      clearCooldown: document.getElementById("debugClearCooldownBtn"),
      peekAlert: document.getElementById("debugPeekAlertBtn"),
      output: document.getElementById("debugOutput"),
    };

    // Only meaningful on-device (these all call into native); hide entirely rather than show
    // buttons that can't do anything on desktop/browser.
    if (!LocalSignals.available()) {
      els.panel.hidden = true;
      return;
    }

    els.runBackground.addEventListener("click", () => run("Running background check…", async () => {
      await LocalSignals.debugRunBackgroundCheck();
      return "Triggered. Check the notification shade / Insights in a moment.";
    }));

    els.sendNudge.addEventListener("click", () => run("Sending…", async () => {
      await LocalSignals.debugSendRiskNudge();
      return "Sent — check the notification shade.";
    }));

    els.sendNightly.addEventListener("click", () => run("Sending…", async () => {
      await LocalSignals.debugSendNightlyCheckin();
      return "Sent — check the notification shade. Try both actions (\"Went well\" should need no app-open; \"Tell me more\" should land on Check-In).";
    }));

    els.clearCooldown.addEventListener("click", () => run("Clearing…", async () => {
      await LocalSignals.debugClearRiskNudgeCooldown();
      return "Cooldown cleared — the next check can notify again even for the same session.";
    }));

    els.peekAlert.addEventListener("click", () => run("Checking…", async () => {
      const raw = await LocalSignals.debugPeekPendingRiskAlert();
      return raw ? raw : "(nothing pending — either none fired yet, or it was already consumed)";
    }));
  }

  async function run(pendingText, action) {
    show(pendingText);
    try {
      show(await action());
    } catch (e) {
      show("Error: " + (e && e.message ? e.message : String(e)));
    }
  }

  function show(text) {
    els.output.hidden = false;
    els.output.textContent = text;
  }

  return { init };
})();
