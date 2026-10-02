/**
 * Privacy-tab card for the browser extension (web version only; see webTracker.js). Shows whether
 * the extension is installed, lets the user turn browser tracking on/off, and edit the two site
 * lists: trigger sites (raise the risk score) and text opt-outs (never scanned for keywords).
 * Hidden entirely on Android, where the native permission cards and allowlist do this job.
 */
const BrowserTrackingView = (function () {
  let els = {};

  function init() {
    els = {
      panel: document.getElementById("browserTrackingPanel"),
      intro: document.getElementById("browserTrackingIntro"),
      setup: document.getElementById("browserTrackingSetup"),
      controls: document.getElementById("browserTrackingControls"),
      toggle: document.getElementById("browserTrackingToggle"),
      triggerList: document.getElementById("triggerSiteList"),
      triggerForm: document.getElementById("triggerSiteForm"),
      triggerInput: document.getElementById("triggerSiteInput"),
      optOutList: document.getElementById("optOutSiteList"),
      optOutForm: document.getElementById("optOutSiteForm"),
      optOutInput: document.getElementById("optOutSiteInput"),
      error: document.getElementById("browserTrackingError"),
      clear: document.getElementById("browserTrackingClear"),
    };
    if (isNative()) return; // Android has its own native cards

    els.toggle.addEventListener("click", async () => {
      const settings = await WebTracker.getSettings();
      await WebTracker.setEnabled(!settings.enabled);
      refresh();
    });
    bindForm(els.triggerForm, els.triggerInput, "triggerDomains");
    bindForm(els.optOutForm, els.optOutInput, "textOptOut");
    els.clear.addEventListener("click", async () => {
      if (!confirm("Delete all browsing data the extension has saved on this device?")) return;
      await WebTracker.clearData();
      refresh();
    });
    refresh();
  }

  function isNative() {
    return !!window.Capacitor?.isNativePlatform?.();
  }

  function bindForm(form, input, list) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const domain = input.value.trim();
      if (!domain) return;
      try {
        await WebTracker.editList(list, "add", domain);
        input.value = "";
        showError("");
        refresh();
      } catch (err) {
        showError(err.message);
      }
    });
  }

  function showError(text) {
    els.error.textContent = text;
    els.error.hidden = !text;
  }

  async function refresh() {
    if (!els.panel || isNative()) return;
    els.panel.hidden = false;
    const found = WebTracker.available();
    els.setup.hidden = found;
    els.controls.hidden = !found;
    els.intro.textContent = found ? "The Reclaim browser extension is connected." : "The Reclaim browser extension isn't installed in this browser.";
    if (!found) return;

    const settings = await WebTracker.getSettings();
    els.toggle.textContent = settings.enabled ? "Browser tracking is on — turn off" : "Turn on browser tracking";
    els.toggle.className = settings.enabled ? "secondary-btn" : "primary-btn";
    renderList(els.triggerList, settings.triggerDomains, "triggerDomains");
    renderList(els.optOutList, settings.textOptOut, "textOptOut");
  }

  function renderList(container, domains, list) {
    container.innerHTML = "";
    for (const domain of domains) {
      const row = document.createElement("div");
      row.className = "allowlist-row";
      const label = document.createElement("span");
      label.className = "allowlist-row-label";
      label.textContent = domain;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "allowlist-remove";
      remove.setAttribute("aria-label", "Remove " + domain);
      remove.textContent = "×";
      remove.addEventListener("click", async () => {
        await WebTracker.editList(list, "remove", domain);
        refresh();
      });
      row.append(label, remove);
      container.appendChild(row);
    }
  }

  return { init, refresh };
})();
