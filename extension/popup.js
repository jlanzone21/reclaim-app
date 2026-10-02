// Popup UI. Talks to background.js with the same ops the web app's bridge uses.
const $ = (id) => document.getElementById(id);

function op(name, payload) {
  return chrome.runtime.sendMessage({ type: "OP", op: name, payload }).then((res) => {
    if (!res?.ok) throw new Error(res?.error || "failed");
    return res.result;
  });
}

async function render() {
  const settings = await op("GET_SETTINGS");
  $("status").textContent = settings.enabled
    ? "Tracking is on. Reclaim can check in with you when browsing looks risky."
    : "Tracking is off. Turn it on to let Reclaim notice risky patterns.";
  $("toggleLabel").textContent = settings.enabled ? "Tracking is on" : "Tracking is off";
  $("toggle").textContent = settings.enabled ? "Turn off" : "Turn on";
  $("toggle").className = settings.enabled ? "" : "primary";
  $("toggle").onclick = async () => {
    await op("SET_ENABLED", { enabled: !settings.enabled });
    render();
  };

  // Per-site opt-out for the current tab, so a user can exclude a site without opening the app.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const host = tab && ReclaimShared.hostnameOf(tab.url);
  const row = $("siteRow");
  if (host && !ReclaimShared.isAppUrl(tab.url)) {
    const sensitive = ReclaimShared.domainMatches(host, ReclaimShared.SENSITIVE_DOMAINS);
    const optedOut = ReclaimShared.domainMatches(host, settings.textOptOut);
    row.hidden = false;
    if (sensitive) {
      $("siteLabel").textContent = `${host}: page text is never read`;
      $("siteToggle").hidden = true;
    } else {
      $("siteToggle").hidden = false;
      $("siteLabel").textContent = optedOut ? `${host}: text not scanned` : `${host}: text scanned`;
      $("siteToggle").textContent = optedOut ? "Scan again" : "Stop scanning";
      $("siteToggle").onclick = async () => {
        await op("SET_LIST", { list: "textOptOut", action: optedOut ? "remove" : "add", domain: host });
        render();
      };
    }
  } else {
    row.hidden = true;
  }

  // Add or remove the current site from the higher-risk ("trigger") list. Works from any normal
  // page, including ones whose text is never scanned: being on the site still counts.
  const triggerRow = $("triggerRow");
  if (host && !ReclaimShared.isAppUrl(tab.url)) {
    const listed = settings.triggerDomains.some((d) => host === d || host.endsWith("." + d));
    triggerRow.hidden = false;
    $("triggerLabel").textContent = listed ? `${host}: counts as higher risk` : `${host}: not on your higher-risk list`;
    $("triggerToggle").textContent = listed ? "Remove" : "Add to higher-risk sites";
    $("triggerToggle").onclick = async () => {
      // Removing needs the exact entry that matched (it may be a parent domain like youtube.com).
      const entry = listed ? settings.triggerDomains.find((d) => host === d || host.endsWith("." + d)) : host;
      await op("SET_LIST", { list: "triggerDomains", action: listed ? "remove" : "add", domain: entry });
      render();
    };
  } else {
    triggerRow.hidden = true;
  }

  const activity = await op("GET_ACTIVITY", { limit: 200 });
  const sites = new Set(activity.sessions.map((s) => s.domain));
  $("summary").textContent = `${activity.sessions.length} visits to ${sites.size} sites and ${activity.matches.length} keyword matches saved on this device.`;
}

$("openApp").onclick = () => chrome.tabs.create({ url: ReclaimShared.APP_ORIGINS[0] + "/" });
$("clear").onclick = async () => {
  if (confirm("Delete all browsing data Reclaim has saved on this device?")) {
    await op("CLEAR_DATA");
    render();
  }
};
// Says what Chrome reported, so "nothing appeared" can be told apart: Chrome refused it, Chrome's
// notification permission is off, or Chrome sent it and Windows is hiding it (Focus assist / Do
// not disturb, or notifications for the browser turned off in Windows Settings).
async function testNotification(kind) {
  try {
    const r = await op("TEST_NOTIFICATION", { kind });
    $("testResult").textContent = r.error
      ? `Chrome refused it: ${r.error}`
      : r.permissionLevel === "denied"
        ? "Chrome's notification permission is turned off for this extension."
        : "Sent. If nothing appeared, Windows is hiding it: check Focus assist / Do not disturb and Settings > System > Notifications for your browser.";
  } catch (e) {
    $("testResult").textContent = "Failed: " + e.message;
  }
}
$("testRisk").onclick = () => testNotification("risk");
$("testNightly").onclick = () => testNotification("nightly");

render();
