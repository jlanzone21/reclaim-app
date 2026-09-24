/**
 * Manages the user-editable allowlist of apps whose on-screen text Reclaim reads (see
 * PURPOSE.md — allowlist, not a blocklist, and it's user-customizable). Renders the current list
 * with a remove button per entry, and an "Add an app" picker over installed apps not already on
 * it (LocalSignals.getInstalledApps(), which only sees launchable apps — see the <queries>
 * declaration in AndroidManifest.xml).
 */
const AllowlistView = (function () {
  let els = {};

  function init() {
    els = {
      list: document.getElementById("allowlistList"),
      empty: document.getElementById("allowlistEmpty"),
      addBtn: document.getElementById("addAllowlistBtn"),
      modal: document.getElementById("addAppOverlay"),
      search: document.getElementById("addAppSearch"),
      results: document.getElementById("addAppResults"),
      close: document.getElementById("addAppClose"),
    };
    els.addBtn.addEventListener("click", openPicker);
    els.close.addEventListener("click", closePicker);
    els.search.addEventListener("input", () => renderResults());
    render();
  }

  let installedCache = null;

  async function render() {
    const apps = await LocalSignals.getAllowlist();
    els.list.innerHTML = "";
    els.empty.hidden = apps.length > 0;

    for (const app of apps) {
      const row = document.createElement("div");
      row.className = "allowlist-row";

      const label = document.createElement("span");
      label.className = "allowlist-row-label";
      label.textContent = app.app_label || app.package_name;
      row.appendChild(label);

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "allowlist-remove";
      removeBtn.setAttribute("aria-label", "Remove");
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", async () => {
        await LocalSignals.removeAllowlistApp(app.package_name);
        render();
      });
      row.appendChild(removeBtn);

      els.list.appendChild(row);
    }
  }

  async function openPicker() {
    els.search.value = "";
    installedCache = null;
    els.modal.classList.add("visible");
    els.results.innerHTML = '<div class="allowlist-picker-loading">Loading installed apps…</div>';
    installedCache = await LocalSignals.getInstalledApps();
    renderResults();
  }

  function closePicker() {
    els.modal.classList.remove("visible");
  }

  async function renderResults() {
    if (!installedCache) return;
    const query = els.search.value.trim().toLowerCase();
    const currentAllowlist = new Set((await LocalSignals.getAllowlist()).map((a) => a.package_name));

    const candidates = installedCache
      .filter((a) => a.packageName !== "com.reclaim.app")
      .filter((a) => !currentAllowlist.has(a.packageName))
      .filter((a) => !query || a.label.toLowerCase().includes(query))
      .sort((a, b) => a.label.localeCompare(b.label));

    els.results.innerHTML = "";
    if (!candidates.length) {
      els.results.innerHTML = '<div class="allowlist-picker-loading">No matching apps</div>';
      return;
    }
    for (const app of candidates) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "allowlist-picker-item";
      btn.textContent = app.label;
      btn.addEventListener("click", async () => {
        await LocalSignals.addAllowlistApp(app.packageName);
        closePicker();
        render();
      });
      els.results.appendChild(btn);
    }
  }

  return { init, refresh: render };
})();
