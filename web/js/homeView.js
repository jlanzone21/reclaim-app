/**
 * The screen the app opens onto. Deliberately shows only the self-reported check-in numbers
 * (via CheckInStore.summary, shared with insightsView.js) -- never the on-device tracking data
 * (usage samples, app events, keyword matches). That's meant to be found deliberately in Insights/
 * Privacy, not sitting on the screen anyone glancing at the phone sees first.
 *
 * Also two one-tap shortcuts: calling the accountability partner, when one's been set -- same real
 * relationship RiskNudgeMonitor's high-risk notification action and the crisis modal already
 * point to, just reachable without waiting for either of those to fire -- and opening the
 * preferences edit form, so it's not buried a tap deep in Privacy.
 */
const HomeView = (function () {
  let els = {};
  let initialized = false;
  // Which day's verse is on screen (and whether it came from YouVersion), so switching back to Home
  // doesn't refetch or flash -- it only re-renders once the day changes or YouVersion recovers.
  let verseShownFor = null;

  function init() {
    els = {
      verseBody: document.getElementById("homeVerseBody"),
      statRow: document.getElementById("homeStatRow"),
      callCards: document.getElementById("homeCallCards"),
      permReminder: document.getElementById("homePermReminder"),
      preferencesCard: document.getElementById("homePreferencesCard"),
    };
    initialized = true;
    // Coming back from the system settings screen after granting something should clear the
    // reminder without needing to switch tabs.
    document.addEventListener("visibilitychange", () => {
      const panel = document.querySelector('[data-view-panel="home"]');
      if (!document.hidden && panel && !panel.hidden) renderPermissionReminder();
    });
    refresh();
  }

  function refresh() {
    if (!initialized) return init();
    renderPermissionReminder();
    renderVerse();
    renderAccountabilityShortcut();
    renderPreferencesShortcut();
    renderStats();
  }

  // Reminder to finish granting permissions (all of them, or just the remaining ones). Tapping it
  // opens the Privacy tab where the Grant buttons live. Renders nothing when everything's granted
  // or there's nothing grantable (web/desktop).
  async function renderPermissionReminder() {
    if (typeof PermissionsView === "undefined") return;
    const missing = await PermissionsView.missing();
    els.permReminder.innerHTML = "";
    if (!missing.length) return;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "home-perm-card";

    const text = document.createElement("span");
    text.className = "home-call-text";
    const label = document.createElement("span");
    label.className = "home-call-label";
    label.textContent = missing.length === 1 ? "1 permission still needs to be enabled" : `${missing.length} permissions still need to be enabled`;
    const sub = document.createElement("span");
    sub.className = "home-call-sub";
    sub.textContent = `Reclaim works best with all of them on — still off: ${missing.join(", ")}. Tap to finish.`;
    text.append(label, sub);
    btn.appendChild(text);

    btn.onclick = () => {
      const privacyNav = document.querySelector('.nav-item[data-view="privacy"]');
      if (privacyNav) privacyNav.click();
    };
    els.permReminder.appendChild(btn);
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

  // A one-tap shortcut to the preferences edit form, same reasoning as the call-partner card
  // above -- reachable from the first screen the app opens onto, not just buried a tap deep in
  // Privacy. Always shown (not conditioned on anything already being filled in), same component
  // shape as buildCallCard so it reads as the same kind of "quick action" row.
  function renderPreferencesShortcut() {
    els.preferencesCard.innerHTML = "";
    els.preferencesCard.appendChild(buildPreferencesCard());
  }

  function buildPreferencesCard() {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "home-call-card";

    const icon = document.createElement("span");
    icon.className = "home-call-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M19.4 13a7.6 7.6 0 0 0 .1-1 7.6 7.6 0 0 0-.1-1l2.1-1.6a.5.5 0 0 0 .1-.6l-2-3.5a.5.5 0 0 0-.6-.2l-2.5 1a7.4 7.4 0 0 0-1.7-1l-.4-2.6a.5.5 0 0 0-.5-.4h-4a.5.5 0 0 0-.5.4l-.4 2.6a7.4 7.4 0 0 0-1.7 1l-2.5-1a.5.5 0 0 0-.6.2l-2 3.5a.5.5 0 0 0 .1.6L4.5 11a7.6 7.6 0 0 0-.1 1 7.6 7.6 0 0 0 .1 1l-2.1 1.6a.5.5 0 0 0-.1.6l2 3.5c.1.2.4.3.6.2l2.5-1c.5.4 1.1.8 1.7 1l.4 2.6c0 .3.2.4.5.4h4c.3 0 .5-.2.5-.4l.4-2.6a7.4 7.4 0 0 0 1.7-1l2.5 1c.2.1.5 0 .6-.2l2-3.5a.5.5 0 0 0-.1-.6L19.4 13ZM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z"/></svg>';
    btn.appendChild(icon);

    const text = document.createElement("span");
    text.className = "home-call-text";
    const label = document.createElement("span");
    label.className = "home-call-label";
    label.textContent = "Preferences";
    const sub = document.createElement("span");
    sub.className = "home-call-sub";
    sub.textContent = "Accountability partner, triggers, coping methods, and how Reclaim reaches you.";
    text.appendChild(label);
    text.appendChild(sub);
    btn.appendChild(text);

    btn.onclick = () => PreferencesView.open("edit");
    return btn;
  }

  // "Today's Verse" is YouVersion's own Verse of the Day (youversion.js), rendered with the
  // YouVersion Bible display and its required copyright attribution. With no app key, offline, or
  // on an API error it falls back to a verse from the local scripture set (resourceRepo.js/
  // seedData.js), so the card is never empty.
  async function renderVerse() {
    const day = new Date().toDateString();
    if (verseShownFor === `yv:${day}`) return;

    if (typeof YouVersion !== "undefined" && YouVersion.available()) {
      if (!verseShownFor) els.verseBody.replaceChildren(verseLine("home-verse-text home-verse-loading", "Loading today's verse…"));
      const display = await YouVersion.getTodaysVerse();
      if (display) {
        els.verseBody.replaceChildren(YouVersion.render(display));
        verseShownFor = `yv:${day}`;
        return;
      }
    }

    if (verseShownFor === `local:${day}`) return;
    const verse = ResourceRepo.getScripture();
    els.verseBody.replaceChildren(
      verseLine("home-verse-text", verse ? verse.body : ""),
      verseLine("home-verse-ref", verse ? verse.title : "")
    );
    verseShownFor = `local:${day}`;
  }

  function verseLine(className, text) {
    const node = document.createElement(className.startsWith("home-verse-text") ? "p" : "div");
    node.className = className;
    node.textContent = text;
    return node;
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
