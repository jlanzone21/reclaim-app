/**
 * Bridge to the Reclaim browser extension (extension/ in this repo) -- the web version's
 * counterpart to localSignals.js. On Android the tracking runs in native code; in a browser the
 * web app can't see other tabs, so the extension watches which site you're on, scores risk, and
 * posts notifications, keeping everything in the browser's own local extension storage. This
 * module is how the app asks the extension for that data. Nothing here touches a network.
 *
 * Transport: window.postMessage to the extension's bridge content script (extension/bridge.js),
 * which is injected only on this app's own origins. available() is false until the extension
 * answers the handshake, so on a plain browser with no extension, in Electron, and on Android
 * (where LocalSignals is used instead) every method is a harmless no-op.
 */
const WebTracker = (function () {
  const HANDSHAKE_TIMEOUT_MS = 2500;
  const REQUEST_TIMEOUT_MS = 4000;

  let installed = false;
  let nextId = 1;
  const waiting = new Map(); // id -> { resolve, reject, timer }
  const listeners = new Set(); // called when the extension says something is pending
  const availableListeners = new Set(); // called once, when the extension is first detected

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const msg = event.data;
    if (!msg || msg.source !== "reclaim-extension") return;

    if (msg.type === "READY") {
      if (!installed) probe();
      return;
    }
    if (msg.type === "PENDING_CHANGED") {
      listeners.forEach((fn) => fn());
      return;
    }
    const entry = waiting.get(msg.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    waiting.delete(msg.id);
    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(new Error(msg.error || "extension error"));
  });

  function request(op, payload, timeoutMs = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error("extension did not answer"));
      }, timeoutMs);
      waiting.set(id, { resolve, reject, timer });
      window.postMessage({ source: "reclaim-app", id, op, payload }, location.origin);
    });
  }

  let probing = null;
  function probe() {
    if (!probing) {
      probing = request("STATUS", {}, HANDSHAKE_TIMEOUT_MS)
        .then((status) => {
          const wasInstalled = installed;
          installed = !!status?.installed;
          if (installed && !wasInstalled) availableListeners.forEach((fn) => fn());
          return installed;
        })
        .catch(() => false)
        .finally(() => {
          probing = null;
        });
    }
    return probing;
  }

  // Resolves once we know whether the extension is there. The bridge may not have injected yet
  // when the app boots, so a second attempt follows its READY announcement (above).
  async function init() {
    if (window.Capacitor?.isNativePlatform?.()) return false;
    return probe();
  }

  function available() {
    return installed;
  }

  async function call(op, payload, fallback) {
    if (!installed) return fallback;
    try {
      return await request(op, payload);
    } catch (e) {
      return fallback;
    }
  }

  const status = () => call("STATUS", {}, null);
  const setEnabled = (enabled) => call("SET_ENABLED", { enabled }, null);
  const getSettings = () => call("GET_SETTINGS", {}, { enabled: false, textOptOut: [], triggerDomains: [] });
  const getActivity = (limit = 20) => call("GET_ACTIVITY", { limit }, { sessions: [], matches: [] });
  const clearData = () => call("CLEAR_DATA", {}, null);
  const getNotificationStats = () => call("GET_STATS", {}, {});
  const appOpened = () => call("APP_OPENED", {}, null);

  // list is "textOptOut" (sites whose text is never scanned) or "triggerDomains" (sites that
  // raise the risk score just by being open). Resolves to the new list, rejects with a message
  // fit to show the user (e.g. "That doesn't look like a site address.").
  async function editList(list, action, domain) {
    if (!installed) return null;
    return request("SET_LIST", { list, action, domain });
  }

  const syncRiskContext = (payload) => call("SYNC_RISK_CONTEXT", payload, null);
  const recordCheckinOutcome = (type, timestampMs, tags) =>
    call("RECORD_OUTCOME", { type, timestamp: timestampMs, tags: tags || [] }, null);

  // { riskAlert, nightly, verse } -- each consumed once (the extension clears them on read), the
  // same pending-flag pattern LocalSignals uses on Android.
  const takePending = () => call("TAKE_PENDING", {}, { riskAlert: null, nightly: null, verse: false });

  function onPending(fn) {
    listeners.add(fn);
  }

  // The extension can appear after the app has booted (it injects at page load, and a user can
  // install it while the app is open), so callers that mirror state to it hook in here.
  function onAvailable(fn) {
    availableListeners.add(fn);
  }

  return {
    init,
    available,
    status,
    setEnabled,
    getSettings,
    getActivity,
    clearData,
    getNotificationStats,
    appOpened,
    editList,
    syncRiskContext,
    recordCheckinOutcome,
    takePending,
    onPending,
    onAvailable,
  };
})();
