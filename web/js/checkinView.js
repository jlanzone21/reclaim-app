const CheckInView = (function () {
  let selectedType = "resisted";
  let selectedTags = new Set();
  let selectedMood = null;
  let selectedUrge = null;

  let els = {};

  function init() {
    els = {
      whenInput: document.getElementById("checkinWhen"),
      tagGrid: document.getElementById("conditionTags"),
      notes: document.getElementById("checkinNotes"),
      moodScale: document.getElementById("moodScale"),
      urgeScale: document.getElementById("urgeScale"),
      form: document.getElementById("checkinForm"),
      list: document.getElementById("checkinList"),
      typeBtns: Array.from(document.querySelectorAll(".type-btn")),
    };

    setDefaultWhen();
    renderTagGrid();
    wireScalePicker(els.moodScale, (v) => (selectedMood = v));
    wireScalePicker(els.urgeScale, (v) => (selectedUrge = v));
    renderRecentList();

    els.typeBtns.forEach((btn) => {
      btn.addEventListener("click", () => setType(btn.dataset.type));
    });

    els.form.addEventListener("submit", handleSubmit);
  }

  function wireScalePicker(container, onChange) {
    Array.from(container.querySelectorAll(".scale-btn")).forEach((btn) => {
      btn.addEventListener("click", () => {
        const isSelected = btn.classList.contains("selected");
        container.querySelectorAll(".scale-btn").forEach((b) => b.classList.remove("selected"));
        if (isSelected) {
          onChange(null); // clicking the already-selected value clears it (fields are optional)
        } else {
          btn.classList.add("selected");
          onChange(parseInt(btn.dataset.value, 10));
        }
      });
    });
  }

  function resetScalePicker(container) {
    container.querySelectorAll(".scale-btn").forEach((b) => b.classList.remove("selected"));
  }

  function setDefaultWhen() {
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    els.whenInput.value = now.toISOString().slice(0, 16);
  }

  function setType(type) {
    selectedType = type;
    els.typeBtns.forEach((btn) => {
      const active = btn.dataset.type === type;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function renderTagGrid() {
    els.tagGrid.innerHTML = "";
    CONDITION_TAGS.forEach((tag) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tag-chip";
      btn.textContent = tag;
      btn.addEventListener("click", () => {
        if (selectedTags.has(tag)) {
          selectedTags.delete(tag);
          btn.classList.remove("selected");
        } else {
          selectedTags.add(tag);
          btn.classList.add("selected");
        }
      });
      els.tagGrid.appendChild(btn);
    });
  }

  function handleSubmit(e) {
    e.preventDefault();
    const whenValue = els.whenInput.value;
    const timestamp = whenValue ? new Date(whenValue).toISOString() : new Date().toISOString();

    const note = els.notes.value.trim();
    // A slip's own words feed the AI's learning, like its tags do (a "resisted" note never lowers anything).
    if (selectedType === "slipped" && note && typeof RiskExplainer !== "undefined") RiskExplainer.learnFromWords(note, "checkin");
    CheckInStore.add({
      timestamp,
      type: selectedType,
      tags: Array.from(selectedTags),
      notes: note,
      mood_rating: selectedMood,
      urge_intensity: selectedUrge,
    });

    selectedTags = new Set();
    selectedMood = null;
    selectedUrge = null;
    renderTagGrid();
    resetScalePicker(els.moodScale);
    resetScalePicker(els.urgeScale);
    els.notes.value = "";
    setType("resisted");
    setDefaultWhen();
    renderRecentList();
  }

  function renderRecentList() {
    const entries = CheckInStore.list().slice(0, 10);
    els.list.innerHTML = "";

    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "checkin-empty";
      empty.textContent = "No check-ins logged yet. Your first entry will show up here.";
      els.list.appendChild(empty);
      return;
    }

    entries.forEach((entry) => {
      const row = document.createElement("div");
      row.className = "checkin-row";

      const badge = document.createElement("span");
      badge.className = `checkin-badge checkin-badge-${entry.type}`;
      badge.textContent = entry.type === "slipped" ? "Slipped" : "Stayed strong";

      const meta = document.createElement("div");
      meta.className = "checkin-row-meta";

      const when = document.createElement("div");
      when.className = "checkin-row-when";
      when.textContent = formatDateTime(entry.timestamp);

      const tags = document.createElement("div");
      tags.className = "checkin-row-tags";
      tags.textContent = entry.tags.length ? entry.tags.join(", ") : "";

      const ratingParts = [];
      if (entry.mood_rating != null) ratingParts.push(`Mood ${entry.mood_rating}/5`);
      if (entry.urge_intensity != null) ratingParts.push(`Urge ${entry.urge_intensity}/5`);

      meta.appendChild(when);
      if (entry.tags.length) meta.appendChild(tags);
      if (ratingParts.length) {
        const ratings = document.createElement("div");
        ratings.className = "checkin-row-tags";
        ratings.textContent = ratingParts.join(" · ");
        meta.appendChild(ratings);
      }
      if (entry.notes) {
        const notes = document.createElement("div");
        notes.className = "checkin-row-notes";
        notes.textContent = entry.notes;
        meta.appendChild(notes);
      }

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "checkin-delete";
      deleteBtn.setAttribute("aria-label", "Delete check-in");
      deleteBtn.textContent = "×";
      deleteBtn.addEventListener("click", () => {
        CheckInStore.remove(entry.id);
        renderRecentList();
      });

      row.appendChild(badge);
      row.appendChild(meta);
      row.appendChild(deleteBtn);
      els.list.appendChild(row);
    });
  }

  function formatDateTime(iso) {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  return { init, renderRecentList };
})();
