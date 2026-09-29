/**
 * The screen the app opens onto. Deliberately shows only the self-reported check-in numbers
 * (via CheckInStore.summary, shared with insightsView.js) -- never the on-device tracking data
 * (usage samples, app events, keyword matches). That's meant to be found deliberately in Insights/
 * Privacy, not sitting on the screen anyone glancing at the phone sees first.
 */
const HomeView = (function () {
  let els = {};
  let initialized = false;

  function init() {
    els = {
      verseText: document.getElementById("homeVerseText"),
      verseRef: document.getElementById("homeVerseRef"),
      statRow: document.getElementById("homeStatRow"),
    };
    initialized = true;
    refresh();
  }

  function refresh() {
    if (!initialized) return init();
    renderVerse();
    renderStats();
  }

  // Draws from the same local scripture set Chat's scripture tool uses (resourceRepo.js/
  // seedData.js) -- no theme filter, so any of the seeded verses can land here. A real "verse of
  // the day" (fixed per calendar day, or drawn from verses added later) is future work, not this
  // pass -- this just wires the spot up to real content instead of leaving it empty.
  function renderVerse() {
    const verse = ResourceRepo.getScripture();
    els.verseText.textContent = verse ? verse.body : "";
    els.verseRef.textContent = verse ? verse.title : "";
  }

  function renderStats() {
    els.statRow.innerHTML = "";
    const s = CheckInStore.summary(CheckInStore.list());

    const streakText = s.streakDays == null ? "—" : String(s.streakDays);
    const streakLabel = s.streakDays == null ? "No slips logged yet" : s.streakDays === 1 ? "day since last slip" : "days since last slip";
    addStatCard(streakText, streakLabel, "streak");
    addStatCard(`${s.recentResisted} / ${s.recentSlipped}`, "stayed strong / slipped (last 30 days)", "ratio");
    addStatCard(s.avgMood == null ? "—" : `${s.avgMood.toFixed(1)}/5`, "avg mood (last 30 days)", "mood");
  }

  function addStatCard(value, label, kind) {
    const card = document.createElement("div");
    card.className = `stat-card stat-card-${kind}`;
    const val = document.createElement("div");
    val.className = "stat-card-value";
    val.textContent = value;
    const lbl = document.createElement("div");
    lbl.className = "stat-card-label";
    lbl.textContent = label;
    card.appendChild(val);
    card.appendChild(lbl);
    els.statRow.appendChild(card);
  }

  return { init, refresh };
})();
