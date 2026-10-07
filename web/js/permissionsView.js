/**
 * Renders one card per tracking permission and handles granting it. Pattern ported from
 * reclaim-beta's permissionsView.js, with reason text rewritten for a real, long-term user
 * instead of a short-term anonymous tester -- these explain what's stored locally and why, not
 * what's sent to a server, since nothing here is ever sent anywhere (see PURPOSE.md).
 */
const PermissionsView = (function () {
  const CAPABILITIES = [
    {
      id: "usage_stats",
      title: "App usage",
      reason: "Notice which app you were recently using, so patterns around your own recovery can be recognized over time. Stored only on this device.",
      module: NativeUsage,
      grant: () => NativeUsage.openPermissionSettings(),
    },
    {
      id: "location",
      title: "Location",
      reason: "Notice whether certain places come up more than others. Stored rounded to a wide area — or, if you choose \"Precise\" in the system prompt, your exact coordinates too. Once granted, you'll be asked to allow it \"all the time\" too, so the periodic background sample gets a fresh fix instead of relying on another app's stale one.",
      module: NativeLocation,
      grant: () => NativeLocation.requestPermission(),
      furtherCheck: () => NativeLocation.hasAlwaysPermission(),
      furtherGrant: () => NativeLocation.requestAlwaysPermission(),
      furtherLabel: "Allow always",
    },
    {
      id: "notifications",
      title: "Notification access",
      reason: "Notes which app most recently sent you a notification. Only the app's name is ever stored, never the notification's text.",
      module: NativeNotifications,
      grant: () => NativeNotifications.openPermissionSettings(),
    },
    {
      id: "nearby_devices",
      title: "Nearby devices",
      reason: "Whether other devices were nearby. Only a rough count is ever stored, never any device's identity.",
      module: NearbyDevices,
      grant: () => NearbyDevices.requestPermission(),
    },
    {
      id: "accessibility",
      title: "Accessibility (read on-screen text)",
      reason: "Right now: reads only your browser's address bar, to note which site was open. Apps you add to your allowlist below will also have their on-screen text read and checked for keywords — never apps you haven't explicitly added.",
      module: NativeAccessibility,
      grant: () => NativeAccessibility.openPermissionSettings(),
    },
    {
      id: "overlay",
      title: "Full-screen check-ins (display over other apps)",
      reason: "When Reclaim notices risky signs, it covers your screen with a check-in you answer — a call to your accountability partner, \"I'm okay,\" or \"false alarm\" — instead of a notification that's easy to swipe away. It only draws Reclaim's own screen: nothing is read or sent. Turn it off any time by revoking this in Android settings.",
      module: NativeOverlay,
      grant: () => NativeOverlay.openPermissionSettings(),
    },
    {
      id: "post_notifications",
      title: "Notifications",
      reason: "Lets Reclaim occasionally check in with a notification — for example, asking whether a detected app session actually matches what you experienced, to verify the tracking is accurate.",
      module: NativeNotify,
      grant: () => NativeNotify.requestPermission(),
    },
  ];

  let els = {};

  function init() {
    els.list = document.getElementById("permList");
    document.addEventListener("visibilitychange", () => {
      const privacyPanel = document.querySelector('[data-view-panel="privacy"]');
      if (!document.hidden && privacyPanel && !privacyPanel.hidden) render();
    });
    render();
  }

  async function render() {
    els.list.innerHTML = "";
    for (const cap of CAPABILITIES) {
      const row = document.createElement("div");
      row.className = "perm-card";

      const info = document.createElement("div");
      info.className = "perm-info";
      const title = document.createElement("div");
      title.className = "perm-title";
      title.textContent = cap.title;
      const reason = document.createElement("div");
      reason.className = "perm-reason";
      reason.textContent = cap.reason;
      info.append(title, reason);

      const status = document.createElement("button");
      status.type = "button";
      status.className = "perm-status";

      if (!cap.module) {
        status.textContent = "Coming soon";
        status.dataset.state = "unavailable";
        status.disabled = true;
      } else if (!cap.module.available()) {
        status.textContent = "Unavailable";
        status.dataset.state = "unavailable";
        status.disabled = true;
      } else if (await cap.module.hasPermission()) {
        if (cap.furtherCheck && !(await cap.furtherCheck())) {
          status.textContent = cap.furtherLabel;
          status.dataset.state = "off";
          status.addEventListener("click", async () => {
            status.textContent = "…";
            status.dataset.state = "pending";
            status.disabled = true;
            try {
              await cap.furtherGrant();
            } catch (e) {
              /* ignore — the status re-check below reflects reality either way */
            }
            render();
          });
        } else {
          status.textContent = "Granted";
          status.dataset.state = "granted";
          status.disabled = true;
        }
      } else {
        status.textContent = "Grant";
        status.dataset.state = "off";
        status.addEventListener("click", async () => {
          status.textContent = "…";
          status.dataset.state = "pending";
          status.disabled = true;
          try {
            await cap.grant();
          } catch (e) {
            /* ignore — the status re-check below reflects reality either way */
          }
          render();
        });
      }

      row.append(info, status);
      els.list.appendChild(row);
    }
  }

  // Titles of the permissions that still need granting, for Home's reminder card. Capabilities
  // that can't be granted here at all (no module, or not Android) are skipped -- otherwise the
  // web/desktop build would nag about something the user has no way to do. A permission with a
  // pending second step (Location's "Allow always") counts as remaining too.
  async function missing() {
    const out = [];
    for (const cap of CAPABILITIES) {
      if (!cap.module || !cap.module.available()) continue;
      try {
        if (!(await cap.module.hasPermission())) out.push(cap.title);
        else if (cap.furtherCheck && !(await cap.furtherCheck())) out.push(cap.title);
      } catch (e) {
        /* can't tell -- don't nag over a failed check */
      }
    }
    return out;
  }

  return { init, refresh: render, missing };
})();
