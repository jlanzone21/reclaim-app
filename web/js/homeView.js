/**
 * The screen the app opens onto. Deliberately shows only the self-reported check-in numbers
 * (via CheckInStore.summary, shared with insightsView.js) -- never the on-device tracking data
 * (usage samples, app events, keyword matches). That's meant to be found deliberately in Insights/
 * Privacy, not sitting on the screen anyone glancing at the phone sees first.
 *
 * Also a one-tap shortcut to call the accountability partner, when one's been set -- same real
 * relationship RiskNudgeMonitor's high-risk notification action and the crisis modal already
 * point to, just reachable without waiting for either of those to fire.
 */
const HomeView = (function () {
  let els = {};
  let initialized = false;

  function init() {
    els = {
      verseText: document.getElementById("homeVerseText"),
      verseRef: document.getElementById("homeVerseRef"),
      statRow: document.getElementById("homeStatRow"),
      callCards: document.getElementById("homeCallCards"),
    };
    initialized = true;
    refresh();
  }

  function refresh() {
    if (!initialized) return init();
    renderVerse();
    renderAccountabilityShortcut();
    renderStats();
  }

  // Same tel: mechanism as the crisis modal and RiskAlertView -- a real anchor click, not a
  // window.location assignment, since that's the one already proven to work here. Up to 2 cards,
  // one per accountability partner who actually has a phone number set -- nothing rendered at all
  // when neither does, same as before.
  function renderAccountabilityShortcut() {
    els.callCards.innerHTML = "";
    const prefs = typeof UserPreferencesStore !== "undefined" ? UserPreferencesStore.get() : null;
    if (!prefs) return;
    [
      { name: prefs.accountability_name, phone: prefs.accountability_phone },
      { name: prefs.accountability_name_2, phone: prefs.accountability_phone_2 },
    ]
      .filter((p) => p.phone)
      .forEach((p) => els.callCards.appendChild(buildCallCard(p)));
  }

  function buildCallCard(partner) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "home-call-card";

    const icon = document.createElement("span");
    icon.className = "home-call-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M6.6 10.8c1.4 2.8 3.8 5.2 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.4 21 3 13.6 3 4.5c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1L6.6 10.8Z"/></svg>';
    btn.appendChild(icon);

    const text = document.createElement("span");
    text.className = "home-call-text";
    const label = document.createElement("span");
    label.className = "home-call-label";
    label.textContent = "Call " + (partner.name || "your accountability partner");
    const sub = document.createElement("span");
    sub.className = "home-call-sub";
    sub.textContent = "Reach out — that's exactly what this relationship is for.";
    text.appendChild(label);
    text.appendChild(sub);
    btn.appendChild(text);

    btn.onclick = () => {
      const a = document.createElement("a");
      a.href = `tel:${partner.phone.replace(/[^\d+]/g, "")}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    };
    return btn;
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
