/**
 * The one-time setup form (up to 2 accountability partners, pastor contact, gender, tempting
 * times/triggers, home location, trigger apps, notification intensity) — shown as the second step
 * of first-launch onboarding (chained from the welcome overlay's "I understand"), and reachable
 * any time after from Privacy's "Edit your preferences" so nothing here is a one-shot, especially
 * the accountability partner contact, which matters most when it's filled in later rather than
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
  let selectedGender = null; // "male" | "female" | null -- optional, unlike intensity there's no default
  // Staged like homeLat/homeLon below -- only actually written on Save, so Skip/Close discards a
  // freshly-added-but-unsaved person the same way it discards an unsaved location capture.
  let partners = []; // [{name, phone}], up to 2
  let pastor = null; // {name, phone} | null
  let mode = "onboarding"; // "onboarding" | "edit" — controls Skip vs Close and what happens on open/close
  let onDone = null;
  let homeLat = null;
  let homeLon = null;

  function init() {
    els = {
      overlay: document.getElementById("preferencesOverlay"),
      partnersList: document.getElementById("prefPartnersList"),
      addPartnerBtn: document.getElementById("prefAddPartnerBtn"),
      partnerForm: document.getElementById("prefPartnerForm"),
      partnerFormName: document.getElementById("prefPartnerFormName"),
      partnerFormPhone: document.getElementById("prefPartnerFormPhone"),
      partnerFormSave: document.getElementById("prefPartnerFormSave"),
      partnerFormCancel: document.getElementById("prefPartnerFormCancel"),
      pastorList: document.getElementById("prefPastorList"),
      addPastorBtn: document.getElementById("prefAddPastorBtn"),
      pastorForm: document.getElementById("prefPastorForm"),
      pastorFormName: document.getElementById("prefPastorFormName"),
      pastorFormPhone: document.getElementById("prefPastorFormPhone"),
      pastorFormSave: document.getElementById("prefPastorFormSave"),
      pastorFormCancel: document.getElementById("prefPastorFormCancel"),
      genderScale: document.getElementById("prefGenderScale"),
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
    wireGenderScale();
    wirePersonForms();
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
    partners = [
      { name: prefs.accountability_name, phone: prefs.accountability_phone || "" },
      { name: prefs.accountability_name_2, phone: prefs.accountability_phone_2 || "" },
    ].filter((p) => p.name);
    els.partnerForm.hidden = true;
    renderPartners();

    pastor = prefs.pastor_name ? { name: prefs.pastor_name, phone: prefs.pastor_phone || "" } : null;
    els.pastorForm.hidden = true;
    renderPastor();

    els.otherNotes.value = prefs.other_notes || "";
    homeLat = prefs.home_lat ?? null;
    homeLon = prefs.home_lon ?? null;
    renderHomeStatus();

    selectedTimes = new Set(prefs.tempting_times || []);
    selectedTriggers = new Set(prefs.common_triggers || []);
    renderChipGrid(els.timeGrid, TEMPTING_TIME_BUCKETS, selectedTimes);
    renderChipGrid(els.triggerGrid, CONDITION_TAGS, selectedTriggers);

    selectedGender = prefs.gender || null;
    Array.from(els.genderScale.querySelectorAll(".scale-btn")).forEach((btn) => {
      btn.classList.toggle("selected", btn.dataset.value === selectedGender);
    });

    selectedIntensity = prefs.notification_intensity || "medium";
    Array.from(els.intensityScale.querySelectorAll(".scale-btn")).forEach((btn) => {
      btn.classList.toggle("selected", btn.dataset.value === selectedIntensity);
    });
  }

  // One row per saved partner (name · phone, with a × remove) plus the "+ Add" button, same
  // visual pattern as the allowlist manager (allowlistView.js) -- reuses its CSS classes directly.
  function renderPartners() {
    els.partnersList.innerHTML = "";
    partners.forEach((p, i) => {
      els.partnersList.appendChild(
        personRow(p, () => {
          partners.splice(i, 1);
          renderPartners();
        })
      );
    });
    els.addPartnerBtn.hidden = partners.length >= 2;
  }

  function renderPastor() {
    els.pastorList.innerHTML = "";
    if (pastor) {
      els.pastorList.appendChild(
        personRow(pastor, () => {
          pastor = null;
          renderPastor();
        })
      );
    }
    els.addPastorBtn.hidden = !!pastor;
  }

  function personRow(person, onRemove) {
    const row = document.createElement("div");
    row.className = "allowlist-row";
    const label = document.createElement("span");
    label.className = "allowlist-row-label";
    label.textContent = person.phone ? `${person.name} · ${person.phone}` : person.name;
    row.appendChild(label);
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "allowlist-remove";
    removeBtn.setAttribute("aria-label", "Remove");
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", onRemove);
    row.appendChild(removeBtn);
    return row;
  }

  // Clicking "+" reveals a small inline name/phone form instead of showing empty inputs up front
  // -- only a name is required to add someone; phone stays optional, same as before.
  function wirePersonForms() {
    els.addPartnerBtn.addEventListener("click", () => {
      els.partnerFormName.value = "";
      els.partnerFormPhone.value = "";
      els.partnerForm.hidden = false;
      els.addPartnerBtn.hidden = true;
      els.partnerFormName.focus();
    });
    els.partnerFormCancel.addEventListener("click", () => {
      els.partnerForm.hidden = true;
      els.addPartnerBtn.hidden = partners.length >= 2;
    });
    els.partnerFormSave.addEventListener("click", () => {
      const name = els.partnerFormName.value.trim();
      if (!name) { els.partnerFormName.focus(); return; }
      partners.push({ name, phone: els.partnerFormPhone.value.trim() });
      els.partnerForm.hidden = true;
      renderPartners();
    });

    els.addPastorBtn.addEventListener("click", () => {
      els.pastorFormName.value = "";
      els.pastorFormPhone.value = "";
      els.pastorForm.hidden = false;
      els.addPastorBtn.hidden = true;
      els.pastorFormName.focus();
    });
    els.pastorFormCancel.addEventListener("click", () => {
      els.pastorForm.hidden = true;
      els.addPastorBtn.hidden = !!pastor;
    });
    els.pastorFormSave.addEventListener("click", () => {
      const name = els.pastorFormName.value.trim();
      if (!name) { els.pastorFormName.focus(); return; }
      pastor = { name, phone: els.pastorFormPhone.value.trim() };
      els.pastorForm.hidden = true;
      renderPastor();
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

  // Unlike intensity, gender has no default -- clicking the already-selected option deselects it,
  // so this stays genuinely optional rather than forcing a choice.
  function wireGenderScale() {
    Array.from(els.genderScale.querySelectorAll(".scale-btn")).forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedGender = selectedGender === btn.dataset.value ? null : btn.dataset.value;
        Array.from(els.genderScale.querySelectorAll(".scale-btn")).forEach((b) =>
          b.classList.toggle("selected", b.dataset.value === selectedGender)
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
      accountability_name: partners[0] ? partners[0].name : "",
      accountability_phone: partners[0] ? partners[0].phone : "",
      accountability_name_2: partners[1] ? partners[1].name : "",
      accountability_phone_2: partners[1] ? partners[1].phone : "",
      pastor_name: pastor ? pastor.name : "",
      pastor_phone: pastor ? pastor.phone : "",
      gender: selectedGender,
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
    const partnerNames = [prefs.accountability_name, prefs.accountability_name_2].filter(Boolean);
    if (partnerNames.length) parts.push(`Accountability partner${partnerNames.length > 1 ? "s" : ""}: ${partnerNames.join(", ")}`);
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
