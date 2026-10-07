// Reclaim browser companion -- service worker.
//
// Records which site you're on and for how long, keeps it ONLY in this browser's local extension
// storage, scores risk with the same transparent arithmetic as the Android app, and posts generic
// notifications. Nothing here makes a network request: there is no fetch() in this extension and
// no host permission for any remote server. See PURPOSE.md ("web version risk tracking").
//
// An MV3 service worker is killed after ~30s idle and restarted on the next event, which wipes
// module scope. So nothing important lives in a variable: durable state is chrome.storage.local,
// the in-flight session is chrome.storage.session (browser memory, survives worker restarts).

importScripts("lib/shared.js", "lib/riskScorer.js", "lib/notificationText.js", "lib/passagePicker.js");

const Shared = ReclaimShared;

const VERSION = chrome.runtime.getManifest().version;
const RUN_GAP_MS = 3 * 60 * 1000; // visits to the same site closer than this are one "run"
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 5000;
const MAX_MATCHES = 1000;
const MATCH_DEDUPE_MS = 2 * 60 * 1000;
const CORRELATION_WINDOW_MS = 6 * 60 * 60 * 1000; // same as LocalSignalsPlugin
const TICK_ALARM = "reclaim-tick";
const NIGHTLY_ALARM = "reclaim-nightly";

// Same generic phrasings as RiskNudgeMonitor.GENERIC_TEXTS. Used only when the user has turned
// "lock-screen detail" OFF in Privacy (default is ON: the notification then says specifically why,
// e.g. "You've been on reddit.com for 22 minutes. Let's check in." -- see lib/notificationText.js).
const GENERIC_TEXTS = [
  "Reclaim wants to check in with you.",
  "Got a second to check in?",
  "Just checking in with you.",
  "Reclaim has a quick check-in for you.",
  "Checking in — got a moment?",
  "A quick check-in, whenever you're ready.",
];

// Same as NightlyCheckinWorker.MESSAGES.
const NIGHTLY_MESSAGES = [
  ["How was today?", "Any struggles worth noting, or did it go well?"],
  ["Evening check-in", "How are you feeling as today wraps up?"],
  ["Quick check-in", "Rough day or a smooth one? Either way, we'd like to know."],
  ["Before you wind down", "Anything from today worth logging?"],
  ["How'd today go?", "No pressure — just checking in on you."],
  ["Checking in", "What was today like for you?"],
  ["One more thing before bed", "How are you doing tonight?"],
  ["Reflecting on today", "Good day, hard day, or somewhere in between?"],
];

// ---- Storage helpers -----------------------------------------------------------------------
//
// Handlers interleave at every await, so read-modify-write of storage is serialised through one
// promise chain; otherwise two events racing would each read the old value and the second would
// overwrite the first.

let chain = Promise.resolve();
function locked(fn) {
  const run = chain.then(fn);
  chain = run.then(
    () => {},
    () => {}
  );
  return run;
}

async function load(key, fallback) {
  const stored = await chrome.storage.local.get(key);
  return stored[key] ?? fallback;
}

function save(key, value) {
  return chrome.storage.local.set({ [key]: value });
}

async function getSettings() {
  const s = await load("settings", {});
  return {
    enabled: !!s.enabled,
    textOptOut: s.textOptOut || [],
    triggerDomains: s.triggerDomains || Shared.DEFAULT_TRIGGER_DOMAINS.slice(),
  };
}

async function getCurrent() {
  const { current } = await chrome.storage.session.get("current");
  return current || null;
}

// ---- Focus tracking -> sessions ------------------------------------------------------------
//
// One notion of "where is the user right now": the active tab of the focused window, unless the
// machine is idle. Every event just calls refreshFocus(); it ends the previous site's session and
// starts the next only when the site actually changed. Sessions are per-SITE (hostname), never
// per-page, so no URL paths or queries are stored.

async function isIdle() {
  const { idleState } = await chrome.storage.session.get("idleState");
  return idleState === "idle" || idleState === "locked";
}

async function focusedTabUrl() {
  const win = await chrome.windows.getLastFocused().catch(() => null);
  if (!win || !win.focused) return null;
  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id }).catch(() => []);
  return tab?.url || null;
}

async function refreshFocus() {
  return locked(async () => {
    const settings = await getSettings();
    const now = Date.now();
    const current = await getCurrent();

    let target = null;
    if (settings.enabled && !(await isIdle())) {
      const url = await focusedTabUrl();
      if (url && Shared.isAppUrl(url)) {
        // Being ON Reclaim is never itself something to flag -- and it's the protective signal.
        await save("lastReclaimOpenAt", now);
      } else {
        target = Shared.hostnameOf(url);
      }
    }

    if ((current?.domain || null) === target) return;

    if (current) await endSession(current, now);
    if (target) {
      await chrome.storage.session.set({ current: { domain: target, start: now } });
      // A hostname like "pornhub.com" is itself evidence even though it isn't page text.
      await recordHostnameKeywords(target, now);
    } else {
      await chrome.storage.session.remove("current");
    }
  });
}

async function endSession(current, endTime) {
  if (endTime - current.start < 1000) return; // accidental/instant navigation
  const sessions = await load("sessions", []);
  sessions.push({ domain: current.domain, start: current.start, end: endTime });
  await save("sessions", prune(sessions, "end", MAX_SESSIONS));
}

function prune(list, timeField, max) {
  const cutoff = Date.now() - RETENTION_MS;
  const kept = list.filter((x) => x[timeField] >= cutoff);
  return kept.length > max ? kept.slice(kept.length - max) : kept;
}

async function recordHostnameKeywords(domain, now) {
  const found = Shared.findKeywords(domain.replace(/\./g, " "));
  if (found.length) await addMatches(domain, found, now);
}

// ---- Keyword matches -----------------------------------------------------------------------

async function addMatches(domain, found, now) {
  const matches = await load("matches", []);
  let changed = false;
  for (const f of found) {
    const dup = matches.findLast((m) => m.domain === domain && m.keyword === f.keyword);
    if (dup && now - dup.at < MATCH_DEDUPE_MS) continue;
    matches.push({ domain, keyword: f.keyword, category: f.category, at: now });
    changed = true;
  }
  if (changed) await save("matches", prune(matches, "at", MAX_MATCHES));
  return changed;
}

function scanAllowed(settings, url) {
  const host = Shared.hostnameOf(url);
  if (!host || !settings.enabled || Shared.isAppUrl(url)) return false;
  if (Shared.domainMatches(host, Shared.SENSITIVE_DOMAINS)) return false;
  if (Shared.domainMatches(host, settings.textOptOut)) return false;
  return true;
}

// ---- Risk evaluation -----------------------------------------------------------------------

// Walks back from the open session through earlier sessions on the same site, merging visits
// less than RUN_GAP_MS apart: that is "how long have you been here" the way Android's foreground
// session is, rather than resetting every time you click a link on the same site.
function runStart(sessions, current) {
  let start = current.start;
  for (let i = sessions.length - 1; i >= 0; i--) {
    const s = sessions[i];
    if (s.end < start - RUN_GAP_MS) break;
    if (s.domain !== current.domain) break;
    start = s.start;
  }
  return start;
}

function minutesSince(ts) {
  return ts ? Math.floor((Date.now() - ts) / 60000) : -1;
}

async function evaluateRisk() {
  const settings = await getSettings();
  if (!settings.enabled) return;
  const current = await getCurrent();
  if (!current) return;

  const [sessions, matches, context, weights, lastReclaimOpenAt, lastNotified] = await Promise.all([
    load("sessions", []),
    load("matches", []),
    load("riskContext", {}),
    load("weights", null),
    load("lastReclaimOpenAt", 0),
    load("lastNotifiedRun", null),
  ]);

  const start = runStart(sessions, current);
  const result = RiskScorer.score({
    domain: current.domain,
    sessionMinutes: Math.floor((Date.now() - start) / 60000),
    hour: new Date().getHours(),
    triggerDomains: settings.triggerDomains,
    context,
    storedWeights: weights,
    keywordSeverity: RiskScorer.mostSevereRecentKeyword(matches, current.domain, Date.now()),
    minutesSinceReclaimOpen: minutesSince(lastReclaimOpenAt),
  });
  console.debug("[reclaim] score", result.score, "threshold", result.threshold, result.reason);
  if (!result.triggers) return;

  // Once per continuous run -- otherwise every tick would re-notify for as long as you stay. An
  // severe-keyword hit is the exception: if this run already nudged for milder reasons, the
  // severe match still gets its own (one more) notification.
  const sameRun = lastNotified && lastNotified.domain === current.domain && lastNotified.start === start;
  if (sameRun && (lastNotified.severe || !result.severe)) return;
  await save("lastNotifiedRun", { domain: current.domain, start, severe: result.severe });

  await postRiskNotification(current.domain, result);
}

// ---- Notifications -------------------------------------------------------------------------
//
// Per-type "sent / responded / unanswered" bookkeeping, ported from NotificationTracking.java.
// A second notification of a type left unanswered after the first escalates to requireInteraction
// (stays on screen until dismissed) -- the browser's honest analogue of Android's full-screen
// intent. Like Android, it cannot force the user's attention away from what they're doing.

async function recordSentAndShouldEscalate(type) {
  const t = await load("notifTracking", { stats: {}, lastAnswered: {} });
  const escalate = t.lastAnswered[type] === false;
  const s = (t.stats[type] ||= { sent: 0, responded: 0 });
  s.sent++;
  t.lastAnswered[type] = false;
  await save("notifTracking", t);
  return escalate;
}

async function recordResponded(type) {
  const t = await load("notifTracking", { stats: {}, lastAnswered: {} });
  if (t.lastAnswered[type] === true) return; // a notification can be answered more than once
  const s = (t.stats[type] ||= { sent: 0, responded: 0 });
  s.responded++;
  t.lastAnswered[type] = true;
  await save("notifTracking", t);
}

// Resolves to an error message, or null on success. chrome.notifications.create reports failure
// only through chrome.runtime.lastError, which used to be ignored -- so a notification Chrome
// refused looked exactly like one the OS was hiding. Also asks the OS whether notifications are
// allowed at all ("granted" / "denied"), the other common reason nothing shows.
function createNotification(id, options) {
  return new Promise((resolve) =>
    chrome.notifications.create(id, options, () => {
      const err = chrome.runtime.lastError?.message || null;
      if (err) console.error("[reclaim] notification failed:", err);
      lastNotificationError = err;
      resolve(err);
    })
  );
}
let lastNotificationError = null;

// A site whose hostname itself matches the keyword list is never NAMED in the notification or
// in-page banner (both are glanceable by anyone near the screen) -- "this site" instead. The full
// name still goes to the in-app alert (pendingAlert.appLabel), which only shows once unlocked.
function speakableSite(domain) {
  return Shared.findKeywords(String(domain).replace(/[.\-]/g, " ")).length ? "this site" : domain;
}

// Which daily passage this nudge offers to pray through (see lib/passagePicker.js), recorded as offered
// today so a later nudge the same day offers a different one. null when the app hasn't synced a plan yet.
async function takePassage(plan, key) {
  const day = PassagePicker.dayNumber();
  const stored = await load("passagesUsed", null);
  const usedToday = stored && stored.day === day && Array.isArray(stored.refs) ? stored.refs : [];
  const pick = PassagePicker.choose(plan, new Set(usedToday), key, day);
  if (pick) await save("passagesUsed", { day, refs: [...usedToday, pick.ref] });
  return pick;
}

async function postRiskNotification(domain, result) {
  const context = await load("riskContext", {});
  const escalate = await recordSentAndShouldEscalate("risk");

  // The passage to pray through (Lectio Divina, in the app): today's passage on the first nudge of the
  // day, after that the one the AI ranked best for this situation (Nathaniel, 2026-10-07).
  const firedIds = new Set(((result.trace && result.trace.factors) || []).filter((f) => f.fired).map((f) => f.id));
  const situation = { sig: NotificationText.noteSignature(firedIds) || "K", bucket: (result.trace && result.trace.timeBucket) || "" };
  const passage = await takePassage(context.passagePlan, PassagePicker.keyFor(situation.sig, situation.bucket));

  // The specific detail is stored for the app to show once it is open -- never in the notification.
  // With a passage, opening the app goes straight into the meditation on it (app.js checkPendingWeb).
  await save("pendingAlert", {
    appLabel: domain,
    reasons: result.userReasons,
    occurredAt: new Date().toISOString(),
    // What the in-app AI explanation is written from, and what the user's verdict is applied to
    // (op RISK_FEEDBACK). `id` makes a verdict idempotent per alert.
    id: Date.now(),
    factors: result.factors,
    trace: result.trace,
    passage: passage ? { ref: passage.ref, description: passage.description } : null,
    situation,
  });
  await save("pendingFactors", { factors: result.factors, postedAt: Date.now() });

  // Tiered like RiskNudgeMonitor: a score well past the bar puts reaching out to a partner first (the
  // app's alert screen then shows tap-to-call buttons) and the meditation second; anything lower, the
  // meditation alone (Nathaniel, 2026-10-07: "partner first on high-risk"). Before the app has synced a
  // plan there's no passage, and the old "Read a verse" stands in.
  const partner = result.isHighRisk ? context.accountabilityName || (context.accountabilityPhone ? "someone" : "") : "";
  const buttons = [];
  const mapping = [];
  if (partner) {
    buttons.push({ title: `Reach out to ${partner === "someone" ? "someone" : partner}` });
    mapping.push("reach");
  }
  if (passage) {
    buttons.push({ title: `Pray through ${passage.ref}` });
    mapping.push("pray");
  } else {
    buttons.push({ title: "Read a verse" });
    mapping.push("verse");
  }
  await save("notifButtons", { risk: mapping });
  const passageLine = passage ? [passage.ref, passage.description].filter(Boolean).join(" · ") : "";

  // Specific text (default) or the generic fallback when the user turned lock-screen detail off,
  // or when nothing specific could be composed.
  const specific = result.trace
    ? NotificationText.compose({
        trace: result.trace.factors,
        app: speakableSite(domain),
        minutes: result.trace.sessionMinutes,
        timeBucket: result.trace.timeBucket,
        bank: context.phraseBank,
        noteBank: context.noteBank,
      })
    : null;
  const text = specific || GENERIC_TEXTS[Math.floor(Math.random() * GENERIC_TEXTS.length)];
  const options = {
    type: "basic",
    iconUrl: "icons/icon.png",
    title: "Reclaim",
    message: text,
    buttons: buttons.slice(0, 2),
    priority: 2,
    requireInteraction: escalate,
  };
  // The passage's reference and one-line description, on its own smaller line under the message.
  if (passageLine) options.contextMessage = passageLine;
  await createNotification("reclaim-risk", options);
  await showBanner("reclaim-risk", text, buttons.slice(0, 2).map((b, i) => ({ title: b.title, action: mapping[i] })), passageLine);
}

async function postNightlyNotification() {
  const escalate = await recordSentAndShouldEscalate("nightly");
  const [title, message] = NIGHTLY_MESSAGES[Math.floor(Math.random() * NIGHTLY_MESSAGES.length)];
  await save("notifButtons", { ...(await load("notifButtons", {})), nightly: ["went_well", "more"] });
  await createNotification("reclaim-nightly", {
    type: "basic",
    iconUrl: "icons/icon.png",
    title,
    message,
    buttons: [{ title: "Went well" }, { title: "Tell me more" }],
    priority: 2,
    requireInteraction: escalate,
  });
  await showBanner("reclaim-nightly", `${title} ${message}`, [
    { title: "Went well", action: "went_well" },
    { title: "Tell me more", action: "more" },
  ]);
}

// One place for what each notification/banner action does, so the system notification's buttons
// and the in-page banner's buttons can't drift apart. `action` is "body" (the notification itself
// was clicked) or a button name from notifButtons: "reach", "pray", "verse", "went_well", "more".
async function performAction(id, action) {
  chrome.notifications.clear(id);
  if (id === "reclaim-risk") {
    await recordResponded("risk");
    // "body" / "pray": nothing to add -- the pending alert carries its passage, and the app opens into the
    // meditation on it. "reach": the check-in screen with the tap-to-call buttons instead.
    if (action === "reach") await save("pendingReach", true);
    if (action === "verse") {
      // Straight to a scripture request, skipping the alert detail screen -- same as Android.
      await save("pendingVerse", true);
      await chrome.storage.local.remove("pendingAlert");
    }
    await openApp();
  } else if (id === "reclaim-nightly") {
    await recordResponded("nightly");
    if (action === "went_well") {
      // Logged by the app on its next load (this worker can't write the app's database). Opening
      // the app is what flushes it, so open it in the background rather than yanking focus.
      await save("pendingNightly", "quick_resisted");
      await openApp({ focus: false });
    } else {
      await save("pendingNightly", "open_checkin");
      await openApp();
    }
  }
}

chrome.notifications.onClicked.addListener((id) => performAction(id, "body"));

chrome.notifications.onButtonClicked.addListener(async (id, index) => {
  const buttons = await load("notifButtons", {});
  const names = id === "reclaim-risk" ? buttons.risk : buttons.nightly;
  await performAction(id, (names || [])[index]);
});

// ---- In-page banner ------------------------------------------------------------------------
//
// Windows hides toast pop-ups while something is fullscreen (a YouTube video, say) or Focus assist
// is on, and that is exactly when a nudge matters. So the same generic message is ALSO drawn on
// the tab the user is looking at (content.js). Same wording and buttons as the notification.
async function showBanner(id, text, buttons, subtext = "") {
  const win = await chrome.windows.getLastFocused().catch(() => null);
  if (!win || !win.focused) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id }).catch(() => []);
  if (!tab?.id || !Shared.hostnameOf(tab.url) || Shared.isAppUrl(tab.url)) return; // the app shows its own alert
  chrome.tabs.sendMessage(tab.id, { type: "SHOW_BANNER", id, text, subtext, buttons }).catch(() => {
    // No content script in this tab (opened before the extension loaded, or a page that blocks
    // them) -- the system notification is still there.
  });
}

// Opens (or focuses) the web app, then nudges it to collect its pending items.
async function openApp({ focus = true } = {}) {
  const tabs = await chrome.tabs.query({ url: Shared.APP_ORIGINS.map((o) => o + "/*") });
  if (tabs.length) {
    const tab = tabs[0];
    if (focus) {
      await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
    chrome.tabs.sendMessage(tab.id, { type: "PENDING_CHANGED" }).catch(() => {});
  } else {
    await chrome.tabs.create({ url: Shared.APP_ORIGINS[0] + "/", active: focus });
  }
}

// ---- Nightly check-in ----------------------------------------------------------------------

function nextNightly() {
  const d = new Date();
  d.setHours(21, 30, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

async function ensureAlarms() {
  await chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
  if (!(await chrome.alarms.get(NIGHTLY_ALARM))) {
    await chrome.alarms.create(NIGHTLY_ALARM, { when: nextNightly(), periodInMinutes: 24 * 60 });
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === TICK_ALARM) {
    await refreshFocus();
    await evaluateRisk();
  } else if (alarm.name === NIGHTLY_ALARM) {
    const settings = await getSettings();
    if (!settings.enabled) return;
    // A browser asleep through the evening fires this late. "How was today?" at breakfast is
    // wrong, so a late fire is skipped rather than delivered.
    const hour = new Date().getHours();
    if (hour < 21) return;
    await postNightlyNotification();
  }
});

// ---- Browser events ------------------------------------------------------------------------

chrome.tabs.onActivated.addListener(() => refreshFocus());
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === "complete") refreshFocus();
});
chrome.tabs.onRemoved.addListener(() => refreshFocus());
chrome.windows.onFocusChanged.addListener(() => refreshFocus());

chrome.idle.setDetectionInterval(60);
chrome.idle.onStateChanged.addListener(async (state) => {
  await chrome.storage.session.set({ idleState: state });
  await refreshFocus();
});

chrome.runtime.onInstalled.addListener(ensureAlarms);
chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarms();
  await refreshFocus();
});
ensureAlarms();

// Consent withdrawal closes the open session immediately (refreshFocus sees enabled=false).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) {
    const was = changes.settings.oldValue?.enabled;
    const now = changes.settings.newValue?.enabled;
    if (was !== now) refreshFocus();
    updateIcon(!!now);
  }
});

async function updateIcon(enabled) {
  // Always-visible "tracking is on" indicator on the toolbar icon.
  chrome.action.setBadgeBackgroundColor({ color: "#fe8722" });
  chrome.action.setBadgeText({ text: enabled ? "●" : "" });
}
getSettings().then((s) => updateIcon(s.enabled));

// ---- Messages ------------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true; // async response
});

async function handleMessage(message, sender) {
  // Content script on an arbitrary page: may only ask whether to scan, and report keyword hits.
  if (message?.type === "SCAN_POLICY") {
    const settings = await getSettings();
    return { ok: true, allowed: scanAllowed(settings, sender.url) };
  }
  if (message?.type === "BANNER_ACTION") {
    // From the banner content script in an ordinary page; only the two known ids and actions.
    const ok = { "reclaim-risk": ["body", "reach", "pray", "verse"], "reclaim-nightly": ["body", "went_well", "more"] };
    if (ok[message.id]?.includes(message.action)) await performAction(message.id, message.action);
    return { ok: true };
  }
  if (message?.type === "KEYWORDS") {
    const settings = await getSettings();
    if (!scanAllowed(settings, sender.url)) return { ok: true };
    // Domain comes from the sender, never from the payload, so a page can't claim another site.
    const domain = Shared.hostnameOf(sender.url);
    const found = (message.matches || [])
      .filter((m) => Shared.KEYWORDS[m.keyword])
      .map((m) => ({ keyword: m.keyword, category: Shared.KEYWORDS[m.keyword] }));
    if (found.length) {
      await locked(() => addMatches(domain, found, Date.now()));
      await evaluateRisk();
    }
    return { ok: true };
  }

  // Everything below hands out or changes tracking data: only the web app (bridge content script
  // on an app origin) or the extension's own popup may ask.
  if (message?.type !== "OP") return { ok: false, error: "unknown message" };
  const fromPopup = sender.url && sender.url.startsWith(chrome.runtime.getURL(""));
  const fromApp = sender.url && Shared.isAppUrl(sender.url);
  if (!fromPopup && !fromApp) return { ok: false, error: "untrusted sender" };

  return runOp(message.op, message.payload || {}, { fromPopup });
}

async function runOp(op, payload, { fromPopup }) {
  switch (op) {
    case "STATUS": {
      const s = await getSettings();
      return { ok: true, result: { installed: true, version: VERSION, enabled: s.enabled } };
    }
    case "SET_ENABLED": {
      const s = await load("settings", {});
      await save("settings", { ...s, enabled: !!payload.enabled });
      if (payload.enabled) await ensureAlarms();
      return { ok: true };
    }
    case "GET_SETTINGS":
      return { ok: true, result: await getSettings() };
    case "SET_LIST": {
      const list = payload.list;
      if (list !== "textOptOut" && list !== "triggerDomains") return { ok: false, error: "bad list" };
      const domain = String(payload.domain || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
      if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return { ok: false, error: "That doesn't look like a site address." };
      const stored = await load("settings", {});
      const current = (await getSettings())[list];
      const next = payload.action === "remove" ? current.filter((d) => d !== domain) : [...new Set([...current, domain])];
      await save("settings", { ...stored, [list]: next });
      return { ok: true, result: next };
    }
    case "GET_ACTIVITY": {
      const limit = Math.min(Number(payload.limit) || 20, 200);
      const [sessions, matches, current] = await Promise.all([load("sessions", []), load("matches", []), getCurrent()]);
      const all = current ? [...sessions, { domain: current.domain, start: current.start, end: Date.now(), open: true }] : sessions;
      return { ok: true, result: { sessions: all.slice(-limit).reverse(), matches: matches.slice(-limit).reverse() } };
    }
    case "SYNC_RISK_CONTEXT": {
      const c = payload || {};
      await save("riskContext", {
        accountabilityName: String(c.accountabilityName || ""),
        accountabilityPhone: String(c.accountabilityPhone || ""),
        accountabilityName2: String(c.accountabilityName2 || ""),
        accountabilityPhone2: String(c.accountabilityPhone2 || ""),
        temptingTimes: Array.isArray(c.temptingTimes) ? c.temptingTimes : [],
        commonTriggers: Array.isArray(c.commonTriggers) ? c.commonTriggers : [],
        intensity: c.intensity || "medium",
        topSlipTags: Array.isArray(c.topSlipTags) ? c.topSlipTags : [],
        riskyTimeBuckets: Array.isArray(c.riskyTimeBuckets) ? c.riskyTimeBuckets : [],
        // AI-written phrase templates (web/js/riskExplainer.js); NotificationText re-validates
        // each one before use, so only the shape is checked here.
        phraseBank: c.phraseBank && typeof c.phraseBank === "object" ? c.phraseBank : {},
        noteBank: c.noteBank && typeof c.noteBank === "object" ? c.noteBank : {},
        // Which daily passage a nudge offers (web/js/passageBank.js); PassagePicker checks every entry.
        passagePlan: c.passagePlan && typeof c.passagePlan === "object" ? c.passagePlan : null,
      });
      return { ok: true };
    }
    case "RISK_FEEDBACK": {
      // The user's verdict on an alert (via the app's AI-assisted feedback). Same bounded +/-
      // nudge as everything else, applied only to adjustable factors that actually fired, once per
      // alert id. Mirrors LocalSignalsPlugin.recordRiskFeedback.
      const alertId = Number(payload.alertId) || 0;
      if (!alertId || alertId === (await load("lastFeedbackAlertId", 0))) {
        return { ok: true, result: { adjusted: [], duplicate: true } };
      }
      await save("lastFeedbackAlertId", alertId);
      const adjustable = (Array.isArray(payload.factors) ? payload.factors : []).filter((f) => RiskScorer.WEIGHT_SPECS[f]);
      await save("weights", RiskScorer.adjustWeights(await load("weights", null), adjustable, !!payload.valid));
      return { ok: true, result: { adjusted: adjustable, duplicate: false } };
    }
    case "NUDGE_WEIGHTS": {
      // Factors the on-device AI judged the person's own words (a slipped check-in's note, a chat
      // message) to be about -- RiskExplainer.learnFromWords. Same bounded +/- step as everything else;
      // the model only picked the category, this does the adjusting. Mirrors
      // LocalSignalsPlugin.nudgeWeights.
      const adjustable = (Array.isArray(payload.factors) ? payload.factors : []).filter((f) => RiskScorer.WEIGHT_SPECS[f]);
      if (adjustable.length) await save("weights", RiskScorer.adjustWeights(await load("weights", null), adjustable, payload.increase !== false));
      return { ok: true, result: { adjusted: adjustable } };
    }
    case "TAKE_PENDING": {
      const [riskAlert, nightly, verse, reach] = await Promise.all([
        load("pendingAlert", null),
        load("pendingNightly", null),
        load("pendingVerse", false),
        load("pendingReach", false),
      ]);
      await chrome.storage.local.remove(["pendingAlert", "pendingNightly", "pendingVerse", "pendingReach"]);
      return { ok: true, result: { riskAlert, nightly, verse, reach } };
    }
    case "RECORD_OUTCOME":
      return { ok: true, result: await recordOutcome(payload) };
    case "GET_STATS": {
      const t = await load("notifTracking", { stats: {} });
      return { ok: true, result: t.stats };
    }
    case "APP_OPENED":
      await save("lastReclaimOpenAt", Date.now());
      return { ok: true };
    case "CLEAR_DATA":
      await chrome.storage.local.remove(["sessions", "matches", "pendingAlert", "pendingNightly", "pendingVerse", "pendingReach", "passagesUsed", "lastNotifiedRun"]);
      return { ok: true };
    case "TEST_NOTIFICATION": {
      if (!fromPopup) return { ok: false, error: "popup only" };
      lastNotificationError = null;
      if (payload.kind === "nightly") await postNightlyNotification();
      else {
        // Runs the real scorer against the current context, then forces a post past the threshold.
        const context = await load("riskContext", {});
        const fake = RiskScorer.score({
          domain: "example.com",
          sessionMinutes: 20,
          hour: new Date().getHours(),
          triggerDomains: ["example.com"],
          context: { ...context, intensity: "low" },
          storedWeights: await load("weights", null),
          keywordSeverity: null,
          minutesSinceReclaimOpen: -1,
        });
        await postRiskNotification("a test site", { ...fake, isHighRisk: payload.high !== false });
      }
      const permissionLevel = await new Promise((r) => chrome.notifications.getPermissionLevel(r));
      return { ok: true, result: { error: lastNotificationError, permissionLevel } };
    }
    default:
      return { ok: false, error: "unknown op" };
  }
}

// Adaptive tuning, both halves, ported from LocalSignalsPlugin.recordCheckinOutcome: factors that
// fired in a recent risk notification, plus the check-in's own tags.
async function recordOutcome({ type, timestamp, tags }) {
  const slipped = type === "slipped";
  const resisted = type === "resisted";
  if (!slipped && !resisted) return null;

  let weights = await load("weights", null);
  const pending = await load("pendingFactors", null);
  await chrome.storage.local.remove("pendingFactors"); // consumed either way -- never matched twice
  if (pending) {
    const elapsed = (Number(timestamp) || Date.now()) - pending.postedAt;
    if (elapsed >= 0 && elapsed <= CORRELATION_WINDOW_MS) {
      weights = RiskScorer.adjustWeights(weights, pending.factors, slipped);
    }
  }
  weights = RiskScorer.adjustWeights(weights, RiskScorer.factorsForTags(tags), slipped);
  await save("weights", weights);
  return weights;
}
