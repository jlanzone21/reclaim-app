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
