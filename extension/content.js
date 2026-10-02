// Runs on web pages. Checks the page's visible text against Reclaim's keyword list and reports
// ONLY which keywords were found -- never the text, never the URL path. The page text is read in
// memory, matched, and discarded; it is never stored or sent anywhere.
//
// Whether to scan at all is the background's decision (SCAN_POLICY): tracking must be on, the
// site must not be on the sensitive list (webmail, banking, health, messaging), and the user must
// not have opted this site out. It is re-asked before every scan so opting out takes effect
// immediately, without reloading the page.

(function () {
  const SCAN_EVERY_MS = 60 * 1000; // re-scan: feeds and SPAs change after load, and a keyword
  //                                  that stays on screen should keep counting as "recent"
  const MAX_CHARS = 200000;
  let lastScan = 0;
  let timer = null;

  async function scan() {
    lastScan = Date.now();
    try {
      const policy = await chrome.runtime.sendMessage({ type: "SCAN_POLICY" });
      if (!policy?.allowed || !document.body) return;
      const found = ReclaimShared.findKeywords(document.body.innerText.slice(0, MAX_CHARS));
      if (found.length) await chrome.runtime.sendMessage({ type: "KEYWORDS", matches: found });
    } catch (e) {
      // Extension reloaded/updated underneath an open page, or a page that blocks scripts --
      // expected and safe to ignore.
    }
  }

  function schedule() {
    if (timer) return;
    const wait = Math.max(2000, SCAN_EVERY_MS - (Date.now() - lastScan));
    timer = setTimeout(() => {
      timer = null;
      if (!document.hidden) scan();
    }, wait);
  }

  scan();
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() - lastScan > SCAN_EVERY_MS) scan();
  });

  // ---- In-page nudge banner (see showBanner in background.js) -----------------------------
  // Drawn in a shadow root so the page's CSS can't restyle or hide it, and attached inside the
  // fullscreen element when there is one -- otherwise a fullscreen video would cover it.
  let bannerHost = null;
  let bannerTimer = null;

  function removeBanner() {
    clearTimeout(bannerTimer);
    if (bannerHost) bannerHost.remove();
    bannerHost = null;
  }

  function showBanner({ id, text, buttons }) {
    removeBanner();
    const host = document.createElement("div");
    host.style.cssText = "all:initial;position:fixed;top:16px;right:16px;z-index:2147483647;";
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      .card{position:relative;font:14px/1.4 system-ui,sans-serif;width:300px;box-sizing:border-box;padding:14px 16px;border-radius:12px;
        background:#06335d;color:#fff;box-shadow:0 8px 28px rgba(0,0,0,.45);border-left:4px solid #fe8722}
      .title{font-weight:700;margin-bottom:4px}
      .row{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
      button{font:inherit;cursor:pointer;border-radius:8px;padding:7px 12px;border:1px solid rgba(255,255,255,.35);background:transparent;color:#fff}
      button.main{background:#fe8722;border-color:#fe8722;font-weight:600}
      .x{position:absolute;top:6px;right:8px;border:0;padding:2px 6px;font-size:16px;opacity:.7}`;
    const card = document.createElement("div");
    card.className = "card";
    const x = document.createElement("button");
    x.className = "x";
    x.setAttribute("aria-label", "Dismiss");
    x.textContent = "\u00d7";
    x.onclick = removeBanner;
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = "Reclaim";
    const body = document.createElement("div");
    body.textContent = text; // textContent, never innerHTML: the text is data, not markup
    const row = document.createElement("div");
    row.className = "row";
    (buttons || []).forEach((b, i) => {
      const btn = document.createElement("button");
      if (i === 0) btn.className = "main";
      btn.textContent = b.title;
      btn.onclick = () => {
        removeBanner();
        chrome.runtime.sendMessage({ type: "BANNER_ACTION", id, action: b.action }).catch(() => {});
      };
      row.appendChild(btn);
    });
    card.append(x, title, body, row);
    root.append(style, card);
    (document.fullscreenElement || document.documentElement).appendChild(host);
    bannerHost = host;
    bannerTimer = setTimeout(removeBanner, 2 * 60 * 1000); // not left on a page forever
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "SHOW_BANNER") showBanner(message);
  });

  // Entering/leaving fullscreen moves the banner into/out of the fullscreen element.
  document.addEventListener("fullscreenchange", () => {
    if (bannerHost) (document.fullscreenElement || document.documentElement).appendChild(bannerHost);
  });
})();
