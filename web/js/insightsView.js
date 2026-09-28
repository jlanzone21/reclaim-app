const InsightsView = (function () {
  let els = {};
  let initialized = false;

  function init() {
    els = {
      statRow: document.getElementById("statRow"),
      chartDaily: document.getElementById("chartDaily"),
      chartTriggers: document.getElementById("chartTriggers"),
      chartTimeOfDay: document.getElementById("chartTimeOfDay"),
      exportBtn: document.getElementById("exportDataBtn"),
      clearBtn: document.getElementById("clearDataBtn"),
      usageList: document.getElementById("activityUsageList"),
      eventsList: document.getElementById("activityEventsList"),
      matchesList: document.getElementById("activityMatchesList"),
    };

    els.exportBtn.addEventListener("click", exportData);
    els.clearBtn.addEventListener("click", clearData);
    initialized = true;
  }

  function refresh() {
    if (!initialized) init();
    const entries = CheckInStore.list();
    renderStats(entries);
    renderDailyChart(entries);
    renderTriggerChart(entries);
    renderTimeOfDayChart(entries);
    // Separate from the check-in charts above (which are instant, local, synchronous) -- this
    // reads through the native LocalSignals bridge, so it renders in as soon as it resolves
    // rather than blocking everything else on it.
    renderRecentActivity();
  }

  function renderStats(entries) {
    els.statRow.innerHTML = "";

    const total = entries.length;
    const lastSlip = entries.find((e) => e.type === "slipped");
    let streakText = "—";
    let streakLabel = "No slips logged yet";
    if (lastSlip) {
      const days = Math.max(0, Math.floor((Date.now() - new Date(lastSlip.timestamp)) / 86400000));
      streakText = String(days);
      streakLabel = days === 1 ? "day since last slip" : "days since last slip";
    }

    const thirtyDaysAgo = Date.now() - 30 * 86400000;
    const recent = entries.filter((e) => new Date(e.timestamp).getTime() >= thirtyDaysAgo);
    const recentResisted = recent.filter((e) => e.type === "resisted").length;
    const recentSlipped = recent.filter((e) => e.type === "slipped").length;

    addStatCard(els.statRow, streakText, streakLabel, "streak");
    addStatCard(els.statRow, String(total), total === 1 ? "check-in logged" : "check-ins logged", "total");
    addStatCard(
      els.statRow,
      `${recentResisted} / ${recentSlipped}`,
      "stayed strong / slipped (last 30 days)",
      "ratio"
    );

    // mood_rating/urge_intensity are optional on every check-in (see checkinStore.js) -- average
    // only over entries where that specific field was filled in, not every check-in, so one
    // person skipping a field doesn't skew everyone's average. sleep_hours isn't shown here
    // anymore since the form no longer collects it (see checkinView.js) -- a card that could only
    // ever show stale historical data or "none logged" forever isn't worth the space.
    addAverageStatCard(recent, "mood_rating", "avg mood (last 30 days)", "mood", 1, "/5");
    addAverageStatCard(recent, "urge_intensity", "avg urge intensity (last 30 days)", "urge", 1, "/5");
  }

  function addAverageStatCard(entries, field, label, kind, decimals, suffix) {
    const values = entries.map((e) => e[field]).filter((v) => v != null);
    if (!values.length) {
      addStatCard(els.statRow, "—", `${label} — none logged yet`, kind);
      return;
    }
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    addStatCard(els.statRow, `${avg.toFixed(decimals)}${suffix}`, label, kind);
  }

  function addStatCard(container, value, label, kind) {
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
    container.appendChild(card);
  }

  function renderDailyChart(entries) {
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      days.push(d);
    }

    const data = days.map((day) => {
      const next = new Date(day);
      next.setDate(next.getDate() + 1);
      const dayEntries = entries.filter((e) => {
        const t = new Date(e.timestamp);
        return t >= day && t < next;
      });
      return {
        label: day.toLocaleDateString(undefined, { weekday: "narrow" }),
        values: [
          { value: dayEntries.filter((e) => e.type === "resisted").length, colorVar: "--success" },
          { value: dayEntries.filter((e) => e.type === "slipped").length, colorVar: "--crisis" },
        ],
      };
    });

    Charts.renderGroupedBars(els.chartDaily, data, {
      height: 160,
      emptyText: "Log a check-in to see your history here",
    });
  }

  function renderTriggerChart(entries) {
    const counts = {};
    entries.forEach((e) => {
      (e.tags || []).forEach((tag) => {
        counts[tag] = (counts[tag] || 0) + 1;
      });
    });

    const data = Object.entries(counts)
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);

    Charts.renderHorizontalBars(els.chartTriggers, data, {
      emptyText: "No conditions tagged yet",
      colorVar: "--accent",
    });
  }

  function renderTimeOfDayChart(entries) {
    const buckets = [
      { label: "Morning", test: (h) => h >= 5 && h < 12 },
      { label: "Afternoon", test: (h) => h >= 12 && h < 17 },
      { label: "Evening", test: (h) => h >= 17 && h < 22 },
      { label: "Night", test: (h) => h >= 22 || h < 5 },
    ];

    const slipped = entries.filter((e) => e.type === "slipped");

    const data = buckets.map((b) => ({
      label: b.label,
      values: [
        {
          value: slipped.filter((e) => b.test(new Date(e.timestamp).getHours())).length,
          colorVar: "--crisis",
        },
      ],
    }));

    Charts.renderGroupedBars(els.chartTimeOfDay, data, {
      height: 140,
      emptyText: "No slips logged — nothing to show here",
    });
  }

  // ---- on-device tracking data (see PURPOSE.md / LocalSignalsDb) ----
  // Unlike the check-in charts above, this reads through the native bridge and won't exist at
  // all until the Privacy tab's permissions are granted -- an empty list here is the honest,
  // correct state until then, not a bug.

  async function renderRecentActivity() {
    if (!LocalSignals.available()) {
      renderActivityList(els.usageList, [], "Not available on this platform");
      renderActivityList(els.eventsList, [], "Not available on this platform");
      renderActivityList(els.matchesList, [], "Not available on this platform");
      return;
    }

    const [samples, events, matches, installedApps] = await Promise.all([
      LocalSignals.getUsageSamples(8),
      LocalSignals.getAppEvents(8),
      LocalSignals.getKeywordMatches(8),
      LocalSignals.getInstalledApps(),
    ]);
    const labelFor = appLabelResolver(installedApps);
    const home = UserPreferencesStore.get();

    renderActivityList(
      els.usageList,
      samples.map((s) => {
        // The domain is more specific and more useful than the app label -- when we know it
        // (browser was open and detected), lead with it and demote the app label to detail.
        const appLabel = s.top_app_package ? labelFor(s.top_app_package) : null;
        const notifLabel = s.recent_notification_package ? labelFor(s.recent_notification_package) : null;
        return {
          when: s.sampled_at,
          main: s.detected_domain || appLabel || "(no app permission)",
          detail: [s.detected_domain && appLabel, notifLabel, homeLabel(s, home)].filter(Boolean).join(" · "),
        };
      }),
      "No background samples yet — grant permissions and turn on background sampling in Privacy"
    );

    renderActivityList(
      els.eventsList,
      events.map((e) => ({ when: e.occurred_at, main: e.app_label || labelFor(e.package_name) })),
      "No app-open events yet"
    );

    renderActivityList(
      els.matchesList,
      matches.map((m) => ({ when: m.occurred_at, main: labelFor(m.package_name), detail: m.matched_keyword })),
      "No keyword matches yet"
    );
  }

  // Turns a usage sample's raw lat/lon into a "Home"/"Away from home" label against the home
  // location saved in onboarding (see UserPreferencesStore's header for why that's never shown as
  // raw coordinates) -- this is the fix for location data that otherwise "doesn't mean anything to
  // the user." Coarse-only samples (no fine location permission) are rounded to 1 decimal degree
  // at the source (~11km, see nativeLocation.js), so a tight radius there would be meaningless --
  // use a much wider one and say "Near home" rather than falsely implying building-level precision.
  function homeLabel(sample, home) {
    if (!home || home.home_lat == null || home.home_lon == null) return null;
    const lat = sample.precise_lat ?? sample.coarse_lat;
    const lon = sample.precise_lon ?? sample.coarse_lon;
    if (lat == null || lon == null) return null;
    const dist = distanceMeters(lat, lon, home.home_lat, home.home_lon);
    if (sample.precise_lat != null) return dist <= 200 ? "Home" : "Away from home";
    return dist <= 15000 ? "Near home" : "Away from home";
  }

  function distanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function appLabelResolver(installedApps) {
    const byPackage = new Map(installedApps.map((a) => [a.packageName, a.label]));
    return (packageName) => byPackage.get(packageName) || packageName;
  }

  function renderActivityList(container, rows, emptyText) {
    container.innerHTML = "";
    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "activity-empty";
      empty.textContent = emptyText;
      container.appendChild(empty);
      return;
    }
    for (const row of rows) {
      const item = document.createElement("div");
      item.className = "activity-row";

      const main = document.createElement("div");
      main.className = "activity-row-main";
      main.textContent = row.main;
      item.appendChild(main);

      if (row.detail) {
        const detail = document.createElement("div");
        detail.className = "activity-row-detail";
        detail.textContent = row.detail;
        item.appendChild(detail);
      }

      const when = document.createElement("div");
      when.className = "activity-row-when";
      when.textContent = formatRelativeTime(row.when);
      item.appendChild(when);

      container.appendChild(item);
    }
  }

  function formatRelativeTime(iso) {
    const diffMs = Date.now() - new Date(iso).getTime();
    const mins = Math.round(diffMs / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  function exportData() {
    const json = CheckInStore.exportJson();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `reclaim-checkins-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function clearData() {
    if (!confirm("Delete all logged check-in data on this device? This can't be undone.")) return;
    CheckInStore.clear();
    refresh();
    CheckInView.renderRecentList();
  }

  return { init, refresh };
})();
