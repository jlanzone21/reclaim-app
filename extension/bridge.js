// Content script injected ONLY on the Reclaim web app's own origins (see manifest.json). Relays
// messages between the page and the extension's background worker, so the web app can read the
// locally stored tracking data without that data ever touching a server.
//
// Protocol (window.postMessage, same window only):
//   page      -> { source: "reclaim-app",       id, op, payload }
//   extension -> { source: "reclaim-extension", id, ok, result, error }
//   extension -> { source: "reclaim-extension", type: "READY" | "PENDING_CHANGED" }   (unsolicited)
//
// The background worker re-checks sender.url against the allowed origins before answering, so
// this file being injected elsewhere (or a page forging messages) cannot widen access.

(function () {
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const msg = event.data;
    if (!msg || msg.source !== "reclaim-app" || typeof msg.op !== "string") return;

    const reply = (body) => window.postMessage({ source: "reclaim-extension", id: msg.id, ...body }, location.origin);
    // sendMessage THROWS (rather than rejecting) once the extension has been reloaded or updated
    // under an already-open page: this copy of the script is orphaned and chrome.runtime is dead.
    // Without the try/catch that surfaced as "Extension context invalidated" and left the app
    // waiting out its timeout. Reloading the page picks up the new extension.
    try {
      chrome.runtime
        .sendMessage({ type: "OP", op: msg.op, payload: msg.payload })
        .then((res) => reply(res))
        .catch((e) => reply({ ok: false, error: String(e?.message || e) }));
    } catch (e) {
      reply({ ok: false, error: "The extension was reloaded - reload this page." });
    }
  });

  // Background asks the page to collect pending items (a notification was clicked).
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "PENDING_CHANGED") {
      window.postMessage({ source: "reclaim-extension", type: "PENDING_CHANGED" }, location.origin);
    }
  });

  // The app's scripts may have run their handshake before this injected; announce readiness too.
  window.postMessage({ source: "reclaim-extension", type: "READY" }, location.origin);
})();
