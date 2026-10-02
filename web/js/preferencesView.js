/**
 * The one-time setup form (up to 2 accountability partners, pastor contact, tempting times/triggers,
 * home location, trigger apps, notification intensity) — shown as the second step of first-launch
 * onboarding (chained from the welcome overlay's "I understand"), and reachable any time after
 * from Privacy's "Edit your preferences" so nothing here is a one-shot, especially the
 * accountability partner contact, which matters most when it's filled in later rather than
 * skipped forever.
 *
 * UserPreferencesStore is the only place this data lives — see its own header for why that's
 * deliberate (it's also what the AI's per-turn context is built from, see personalContext.js —
 * except home_lat/home_lon, deliberately not part of that context; see UserPreferencesStore's
 * header for why).
 */
const PreferencesView = (function () {
  let els = {};
  let selectedTimes = new Set();
  let selectedTriggers = new Set();
  let selectedIntensity = "medium";
  let mode = "onboarding"; // "onboarding" | "edit" — controls Skip vs Close and what happens on open/close
  let onDone = null;
  // Staged like every other field here -- only actually written on Save, so Skip/Close discards a
  // freshly-captured-but-unsaved location the same way it discards an unsaved name/phone edit.
  let homeLat = null;
  let homeLon = null;

  function init() {
    els = {
      overlay: document.getElementById("preferencesOverlay"),
      accountabilityName: document.getElementById("prefAccountabilityName"),
      accountabilityPhone: document.getElementById("prefAccountabilityPhone"),
      accountabilityName2: document.getElementById("prefAccountabilityName2"),
      accountabilityPhone2: document.getElementById("prefAccountabilityPhone2"),
      pastorName: document.getElementById("prefPastorName"),
      pastorPhone: document.getElementById("prefPastorPhone"),
      timeGrid: document.getElementById("prefTimeGrid"),
      triggerGrid: document.getElementById("prefTriggerGrid"),
      homeStatus: document.getElementById("prefHomeStatus"),
      saveHomeBtn: document.getElementById("prefSaveHomeBtn"),
      clearHomeBtn: document.getElementById("prefClearHomeBtn"),
      allowlistSummary: document.getElementById("prefAllowlistSummary"),
      intensityScale: document.getElementById("prefIntensityScale"),
      otherNotes: document.getElementById("prefOtherNotes"),
      save: document.getElementById("preferencesSave"),
      skip: document.getElementById("preferencesSkip"),
      close: document.getElementById("preferencesClose"),
      editBtn: document.getElementById("editPreferencesBtn"),
      summary: document.getElementById("preferencesSummary"),
    };

    renderChipGrid(els.timeGrid, TEMPTING_TIME_BUCKETS, selectedTimes);
    renderChipGrid(els.triggerGrid, CONDITION_TAGS, selectedTriggers);
    wireIntensityScale();
    wireHomeLocation();

    els.save.addEventListener("click", () => { persist(true); close(); });
    els.skip.addEventListener("click", () => close());
    els.close.addEventListener("click", () => close());
    els.editBtn.addEventListener("click", () => open("edit"));

    renderSummary();
  }

  // Onboarding mode: user hasn't answered yet, "Skip for now" is offered, closing either way just
  // dismisses. Edit mode: form is pre-filled from what's saved, only "Close" is offered (Save
  // still writes, Close alone doesn't discard anything since fields save on click, not on open).
  function open(requestedMode, doneCallback) {
    mode = requestedMode;
    onDone = doneCallback || null;
    const prefs = UserPreferencesStore.get();
    fillForm(prefs);
    els.skip.hidden = mode !== "onboarding";
    els.close.hidden = mode === "onboarding";
    renderAllowlistSummary();
    els.overlay.classList.add("visible");
  }

  function close() {
    els.overlay.classList.remove("visible");
    if (onDone) onDone();
  }

  function fillForm(prefs) {
    els.accountabilityName.value = prefs.accountability_name || "";
    els.accountabilityPhone.value = prefs.accountability_phone || "";
    els.accountabilityName2.value = prefs.accountability_name_2 || "";
    els.accountabilityPhone2.value = prefs.accountability_phone_2 || "";
    els.pastorName.value = prefs.pastor_name || "";
    els.pastorPhone.value = prefs.pastor_phone || "";
    els.otherNotes.value = prefs.other_notes || "";
    homeLat = prefs.home_lat ?? null;
    homeLon = prefs.home_lon ?? null;
    renderHomeStatus();

    selectedTimes = new Set(prefs.tempting_times || []);
    selectedTriggers = new Set(prefs.common_triggers || []);
    renderChipGrid(els.timeGrid, TEMPTING_TIME_BUCKETS, selectedTimes);
    renderChipGrid(els.triggerGrid, CONDITION_TAGS, selectedTriggers);

    selectedIntensity = prefs.notification_intensity || "medium";
    Array.from(els.intensityScale.querySelectorAll(".scale-btn")).forEach((btn) => {
      btn.classList.toggle("selected", btn.dataset.value === selectedIntensity);
    });
  }

  function renderChipGrid(container, options, selectedSet) {
    container.innerHTML = "";
    options.forEach((option) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tag-chip";
      btn.textContent = option;
      btn.classList.toggle("selected", selectedSet.has(option));
      btn.addEventListener("click", () => {
        if (selectedSet.has(option)) selectedSet.delete(option);
        else selectedSet.add(option);
        btn.classList.toggle("selected", selectedSet.has(option));
      });
      container.appendChild(btn);
    });
  }

  function wireIntensityScale() {
    Array.from(els.intensityScale.querySelectorAll(".scale-btn")).forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedIntensity = btn.dataset.value;
        Array.from(els.intensityScale.querySelectorAll(".scale-btn")).forEach((b) =>
          b.classList.toggle("selected", b === btn)
        );
      });
    });
  }

  function wireHomeLocation() {
    els.saveHomeBtn.addEventListener("click", async () => {
      if (typeof NativeLocation === "undefined" || !NativeLocation.available()) {
        els.homeStatus.textContent = "Not available on this platform.";
        return;
      }
      els.saveHomeBtn.disabled = true;
      els.homeStatus.textContent = "Getting your location…";
      try {
        let granted = await NativeLocation.hasPermission();
        if (!granted) granted = await NativeLocation.requestPermission();
        if (!granted) {
          els.homeStatus.textContent = "Location permission needed — grant it from Privacy, then try again.";
          return;
        }
        const pos = await NativeLocation.getPosition();
        const lat = pos && (pos.precise_lat ?? pos.coarse_lat);
        const lon = pos && (pos.precise_lon ?? pos.coarse_lon);
        if (lat == null || lon == null) {
          els.homeStatus.textContent = "Couldn't get your location — try again in a moment.";
          return;
        }
        homeLat = lat;
        homeLon = lon;
        renderHomeStatus();
      } finally {
        els.saveHomeBtn.disabled = false;
      }
    });

    els.clearHomeBtn.addEventListener("click", () => {
      homeLat = null;
      homeLon = null;
      renderHomeStatus();
    });
  }

  function renderHomeStatus() {
    const isSet = homeLat != null && homeLon != null;
    els.homeStatus.textContent = isSet ? "Home location set." : "Not set yet.";
    els.clearHomeBtn.hidden = !isSet;
  }

  async function renderAllowlistSummary() {
    if (!LocalSignals.available()) {
      els.allowlistSummary.textContent = "Not available on this platform.";
      return;
    }
    try {
      const apps = await LocalSignals.getAllowlist();
      els.allowlistSummary.textContent = apps.length
        ? `Currently: ${apps.map((a) => a.app_label || a.package_name).join(", ")}.`
        : "None added yet.";
    } catch (e) {
      els.allowlistSummary.textContent = "Couldn't load right now.";
    }
  }

  function persist(markOnboardingDone) {
    const prefs = UserPreferencesStore.get();
    const fields = {
      accountability_name: els.accountabilityName.value.trim(),
      accountability_phone: els.accountabilityPhone.value.trim(),
      accountability_name_2: els.accountabilityName2.value.trim(),
      accountability_phone_2: els.accountabilityPhone2.value.trim(),
      pastor_name: els.pastorName.value.trim(),
      pastor_phone: els.pastorPhone.value.trim(),
      tempting_times: Array.from(selectedTimes),
      common_triggers: Array.from(selectedTriggers),
      notification_intensity: selectedIntensity,
      other_notes: els.otherNotes.value.trim(),
      home_lat: homeLat,
      home_lon: homeLon,
    };
    if (markOnboardingDone && !prefs.onboarding_completed_at) {
      fields.onboarding_completed_at = new Date().toISOString();
    }
    UserPreferencesStore.save(fields);
    renderSummary();
  }

  function renderSummary() {
    const prefs = UserPreferencesStore.get();
    const parts = [];
    const partners = [prefs.accountability_name, prefs.accountability_name_2].filter(Boolean);
    if (partners.length) parts.push(`Accountability partner${partners.length > 1 ? "s" : ""}: ${partners.join(", ")}`);
    if (prefs.tempting_times && prefs.tempting_times.length) parts.push(`Hardest times: ${prefs.tempting_times.join(", ")}`);
    parts.push(`Notifications: ${capitalize(prefs.notification_intensity)}`);
    els.summary.textContent = parts.length
      ? parts.join(" · ")
      : "Not set up yet — accountability partner, tempting times, and how often you want to hear from Reclaim.";
  }

  function capitalize(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  return { init, open };
})();
