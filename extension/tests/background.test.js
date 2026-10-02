// Run: node extension/tests/background.test.js
// Loads the real background.js against a stubbed `chrome` and drives it the way the browser would:
// focus changes -> sessions, keyword reports, risk scoring -> notification, notification clicks ->
// pending items for the web app, and the sender checks that keep other sites out.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function makeChrome() {
  const local = {}, session = {};
  const area = (store) => ({
    get: async (key) => (typeof key === "string" ? (key in store ? { [key]: structuredClone(store[key]) } : {}) : {}),
    set: async (o) => Object.assign(store, structuredClone(o)),
    remove: async (keys) => [].concat(keys).forEach((k) => delete store[k]),
  });
  const ev = () => ({ addListener() {} });
  const listeners = { onMessage: null, onClicked: null, onButtonClicked: null };
  const state = { focusedUrl: null, windowFocused: true, notifications: [], tabs: [], created: [], updated: [], sent: [] };
  const chrome = {
    runtime: {
      lastError: undefined,
      getManifest: () => ({ version: "test" }),
      getURL: () => "chrome-extension://abc/",
      onMessage: { addListener: (fn) => (listeners.onMessage = fn) },
      onInstalled: ev(), onStartup: ev(),
    },
    storage: { local: area(local), session: area(session), onChanged: ev() },
    tabs: {
      onActivated: ev(), onUpdated: ev(), onRemoved: ev(),
      query: async (q) => (q.url ? state.tabs : state.focusedUrl ? [{ url: state.focusedUrl }] : []),
      update: async (id, o) => state.updated.push([id, o]),
      create: async (o) => state.created.push(o),
      sendMessage: async (id, m) => state.sent.push([id, m]),
    },
    windows: { onFocusChanged: ev(), getLastFocused: async () => ({ id: 1, focused: state.windowFocused }), update: async () => {} },
    idle: { setDetectionInterval() {}, onStateChanged: ev() },
    alarms: { create: async () => {}, get: async () => ({}), onAlarm: ev() },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    notifications: {
      getPermissionLevel: (cb) => cb('granted'),
      create: (id, opts, cb) => { state.notifications.push({ id, ...opts }); cb && cb(id); },
      clear() {},
      onClicked: { addListener: (fn) => (listeners.onClicked = fn) },
      onButtonClicked: { addListener: (fn) => (listeners.onButtonClicked = fn) },
    },
  };
  return { chrome, local, session, state, listeners };
}

async function boot() {
  const env = makeChrome();
  const dir = path.join(__dirname, "..");
  const sandbox = { chrome: env.chrome, console: { debug() {}, log: console.log, warn() {}, error: console.error }, structuredClone, setTimeout, Date, URL, Math };
  sandbox.globalThis = sandbox;
  sandbox.importScripts = (...files) => files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(dir, f), "utf8"), ctx, { filename: f }));
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(dir, "background.js"), "utf8"), ctx, { filename: "background.js" });
  const send = (message, senderUrl) =>
    new Promise((resolve) => env.listeners.onMessage(message, { url: senderUrl }, resolve));
  const op = (name, payload, url = "https://reclaim128.org/") => send({ type: "OP", op: name, payload }, url);
  // refreshFocus is a script-level function declaration, so it's reachable on the context.
  const focus = async (url) => { env.state.focusedUrl = url; await vm.runInContext("refreshFocus()", ctx); };
  const tick = () => vm.runInContext("evaluateRisk()", ctx);
  return { ...env, send, op, focus, tick, ctx };
}

(async () => {
  let t = await boot();

  // Untrusted senders get nothing, whatever they ask.
  let r = await t.op("GET_ACTIVITY", {}, "https://evil.example/");
  assert.equal(r.ok, false);
  r = await t.op("GET_ACTIVITY", {}, "https://reclaim128.org.evil.example/");
  assert.equal(r.ok, false);
  r = await t.op("GET_ACTIVITY", {}, "http://localhost:4173/");
  assert.equal(r.ok, true);
  // Test notifications are popup-only.
  r = await t.op("TEST_NOTIFICATION", { kind: "risk" }, "https://reclaim128.org/");
  assert.equal(r.ok, false);

  // Nothing is recorded until consent.
  await t.focus("https://www.reddit.com/r/foo?x=1");
  assert.equal((await t.op("GET_ACTIVITY", {})).result.sessions.length, 0);

  // Consent on -> sessions are per-site (no path/query), www stripped.
  await t.op("SET_ENABLED", { enabled: true });
  await t.focus("https://www.reddit.com/r/foo?x=1");
  assert.deepEqual(t.session.current && t.session.current.domain, "reddit.com");
  // Switching sites ends the first session; Reclaim itself is never tracked as a site.
  t.session.current.start -= 5000; // pretend 5s elapsed
  await t.focus("https://news.example.com/article");
  t.session.current.start -= 5000;
  await t.focus("http://localhost:4173/");
  assert.equal(t.session.current, undefined);
  let act = (await t.op("GET_ACTIVITY", {})).result;
  assert.deepEqual(act.sessions.map((s) => s.domain), ["news.example.com", "reddit.com"]);
  assert.ok(act.sessions.some((s) => s.domain === "reddit.com"));
  assert.ok(JSON.stringify(t.local).indexOf("/r/foo") === -1, "no URL paths in storage");
  // Opening Reclaim records the protective signal.
  assert.ok(t.local.lastReclaimOpenAt > 0);

  // Unfocused browser / idle ends tracking.
  t = await boot();
  await t.op("SET_ENABLED", { enabled: true });
  await t.focus("https://youtube.com/watch?v=1");
  assert.equal(t.session.current.domain, "youtube.com");
  t.state.windowFocused = false;
  await t.focus("https://youtube.com/watch?v=1");
  assert.equal(t.session.current, undefined);
  t.state.windowFocused = true;

  // Keyword reports: domain comes from the sender, sensitive/opted-out sites are refused.
  await t.send({ type: "KEYWORDS", matches: [{ keyword: "nsfw" }, { keyword: "bogus" }] }, "https://www.reddit.com/r/x");
  assert.deepEqual(t.local.matches.map((m) => [m.domain, m.keyword, m.category]), [["reddit.com", "nsfw", "explicit_content"]]);
  await t.send({ type: "KEYWORDS", matches: [{ keyword: "porn" }] }, "https://mail.google.com/mail");
  assert.equal(t.local.matches.length, 1, "sensitive domain refused");
  await t.op("SET_LIST", { list: "textOptOut", action: "add", domain: "https://www.OptedOut.com/page" });
  assert.deepEqual((await t.op("GET_SETTINGS", {})).result.textOptOut, ["optedout.com"]);
  await t.send({ type: "KEYWORDS", matches: [{ keyword: "porn" }] }, "https://optedout.com/");
  assert.equal(t.local.matches.length, 1, "opted-out domain refused");
  assert.equal((await t.send({ type: "SCAN_POLICY" }, "https://optedout.com/")).allowed, false);
  assert.equal((await t.send({ type: "SCAN_POLICY" }, "https://blog.example.com/")).allowed, true);
  assert.equal((await t.send({ type: "SCAN_POLICY" }, "https://reclaim128.org/")).allowed, false);
  assert.equal((await t.op("SET_LIST", { list: "textOptOut", action: "add", domain: "nope" })).ok, false);

  // Hostname keywords count as evidence even though they aren't page text.
  t = await boot();
  await t.op("SET_ENABLED", { enabled: true });
  await t.focus("https://www.pornhub.com/");
  assert.equal(t.local.matches[0].keyword, "pornhub");

  // Risk: a trigger site + enough time + keyword evidence -> ONE generic notification per run.
  t = await boot();
  await t.op("SET_ENABLED", { enabled: true });
  await t.op("SYNC_RISK_CONTEXT", { intensity: "medium", accountabilityName: "Sam", accountabilityPhone: "5551234", temptingTimes: [], riskyTimeBuckets: [] });
  await t.focus("https://old.reddit.com/");
  await t.tick();
  assert.equal(t.state.notifications.length, 0, "just arrived: below threshold");
  t.session.current.start -= 16 * 60 * 1000; // 16 minutes on a trigger site = 60
  await t.tick();
  assert.equal(t.state.notifications.length, 1);
  const n = t.state.notifications[0];
  assert.equal(n.id, "reclaim-risk");
  assert.ok(!/reddit|trigger|minute/i.test(n.title + n.message), "notification text is generic");
  assert.ok(n.buttons.some((b) => b.title === "Read a verse"));
  assert.equal(n.requireInteraction, false, "first one doesn't escalate");
  await t.tick();
  assert.equal(t.state.notifications.length, 1, "no repeat for the same run");
  // Detail is stored for the app, not the notification.
  assert.ok(t.local.pendingAlert.reasons.length >= 2);
  assert.equal(t.local.pendingAlert.appLabel, "old.reddit.com");

  // Clicking the body: opens the app (new tab, none open), pending alert stays for the app to take.
  await t.listeners.onClicked("reclaim-risk");
  assert.equal(t.state.created.length, 1);
  assert.equal(t.state.created[0].url, "https://reclaim128.org/");
  let p = (await t.op("TAKE_PENDING", {})).result;
  assert.ok(p.riskAlert && !p.verse);
  p = (await t.op("TAKE_PENDING", {})).result;
  assert.equal(p.riskAlert, null, "consumed once");
  assert.equal((await t.op("GET_STATS", {})).result.risk.responded, 1);

  // Next run (different start): the previous one WAS answered, so no escalation. Then an
  // unanswered one escalates the following time.
  await t.focus("https://youtube.com/");
  t.session.current.start -= 20 * 60 * 1000;
  await t.tick();
  assert.equal(t.state.notifications.length, 2);
  assert.equal(t.state.notifications[1].requireInteraction, false);
  await t.focus("https://instagram.com/");
  t.session.current.start -= 20 * 60 * 1000;
  await t.tick();
  assert.equal(t.state.notifications.length, 3);
  assert.equal(t.state.notifications[2].requireInteraction, true, "previous one unanswered -> escalate");

  // "Read a verse" button: pending verse, alert cleared, app opened via existing tab.
  t.state.tabs = [{ id: 7, windowId: 2 }];
  const verseIdx = t.state.notifications[2].buttons.findIndex((b) => b.title === "Read a verse");
  await t.listeners.onButtonClicked("reclaim-risk", verseIdx);
  p = (await t.op("TAKE_PENDING", {})).result;
  assert.equal(p.verse, true);
  assert.equal(p.riskAlert, null);
  assert.equal(JSON.stringify(t.state.updated[0]), JSON.stringify([7, { active: true }]));
  assert.equal(t.state.sent.at(-1)[1].type, "PENDING_CHANGED");

  // Nightly: buttons log via pending flags, background-open doesn't steal focus.
  await t.op("TEST_NOTIFICATION", { kind: "nightly" }, "chrome-extension://abc/popup.html");
  const nn = t.state.notifications.at(-1);
  assert.equal(nn.id, "reclaim-nightly");
  t.state.updated.length = 0;
  await t.listeners.onButtonClicked("reclaim-nightly", 0);
  assert.equal((await t.op("TAKE_PENDING", {})).result.nightly, "quick_resisted");
  assert.equal(t.state.updated.length, 0, "went-well doesn't pull focus");
  await t.listeners.onButtonClicked("reclaim-nightly", 1);
  assert.equal((await t.op("TAKE_PENDING", {})).result.nightly, "open_checkin");

  // Explicit keyword: one report on a brand-new, non-trigger site notifies immediately and is
  // high risk -- even at Low intensity -- and is still allowed after a milder nudge in the same run.
  t = await boot();
  await t.op("SET_ENABLED", { enabled: true });
  await t.op("SYNC_RISK_CONTEXT", { intensity: "low", accountabilityName: "Sam", accountabilityPhone: "5551234" });
  await t.focus("https://blog.example.com/");
  await t.send({ type: "KEYWORDS", matches: [{ keyword: "nsfw" }] }, "https://blog.example.com/");
  assert.equal(t.state.notifications.length, 0, "ordinary keyword alone still doesn't notify at Low");
  await t.send({ type: "KEYWORDS", matches: [{ keyword: "porn" }] }, "https://blog.example.com/");
  assert.equal(t.state.notifications.length, 1, "explicit keyword notifies at once");
  assert.ok(t.state.notifications[0].buttons[0].title.startsWith("Reach out"), "high risk -> reach out");
  assert.ok(t.local.pendingAlert.reasons[0].includes("pornography"));
  await t.tick();
  assert.equal(t.state.notifications.length, 1, "no repeat");

  // Adaptive tuning: slip shortly after a notification reinforces the factors that fired;
  // tags apply independently; a stale notification is not correlated.
  t = await boot();
  await t.op("SET_ENABLED", { enabled: true });
  t.local.pendingFactors = { factors: ["triggerApp", "duration"], postedAt: Date.now() - 60000 };
  await t.op("RECORD_OUTCOME", { type: "slipped", timestamp: Date.now(), tags: ["Fatigue", "Late at night"] });
  assert.deepEqual(
    [t.local.weights.triggerApp, t.local.weights.duration, t.local.weights.selfReportedTime, t.local.weights.historicalTime],
    [32, 32, 22, 17]
  );
  assert.equal(t.local.pendingFactors, undefined, "consumed");
  t.local.pendingFactors = { factors: ["triggerApp"], postedAt: Date.now() - 7 * 3600 * 1000 };
  await t.op("RECORD_OUTCOME", { type: "resisted", timestamp: Date.now(), tags: [] });
  assert.equal(t.local.weights.triggerApp, 32, "outside the 6h window: untouched");

  // Withdrawing consent stops tracking immediately; deleting data clears history.
  await t.op("SET_ENABLED", { enabled: true });
  await t.focus("https://example.com/");
  await t.op("SET_ENABLED", { enabled: false });
  await t.focus("https://example.com/");
  assert.equal(t.session.current, undefined);
  await t.op("CLEAR_DATA", {});
  assert.equal(t.local.sessions, undefined);

  console.log("all background tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
