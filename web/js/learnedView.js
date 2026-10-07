/**
 * Privacy > "What Reclaim has learned": shows the preference profile built from thumbs up/down on
 * Chat's resource cards (resourceFeedback.js), with a way to forget any one kind of resource or
 * theme, or everything. Visible and resettable on purpose -- the person should always be able to
 * see what the app has concluded about them and undo it.
 */
const LearnedView = (function () {
  // Below this either way, a type/keyword reads as "mixed" rather than helpful/less helpful: one
  // thumbs scores +/-0.33 (see PRIOR in resourceFeedback.js), so a single rating does show.
  const LEAN = 0.15;
  const MAX_KEYWORDS = 8;
  let els = {};

  function init() {
    els = {
      types: document.getElementById("learnedTypes"),
      typesTitle: document.getElementById("learnedTypesTitle"),
      keywords: document.getElementById("learnedKeywords"),
      keywordsTitle: document.getElementById("learnedKeywordsTitle"),
      empty: document.getElementById("learnedEmpty"),
      clear: document.getElementById("clearFeedbackBtn"),
    };
    if (!els.types) return;
    els.clear.addEventListener("click", () => {
      if (!confirm("Clear everything Reclaim has learned from your thumbs up and down? This can't be undone.")) return;
      ResourceFeedback.clearAll();
      refresh();
    });
    refresh();
  }

  function lean(score) {
    if (score >= LEAN) return { text: "Helpful", cls: "learned-up" };
    if (score <= -LEAN) return { text: "Less helpful", cls: "learned-down" };
    return { text: "Mixed", cls: "learned-mixed" };
  }

  function row(label, score, onForget) {
    const r = document.createElement("div");
    r.className = "allowlist-row";
    const name = document.createElement("span");
    name.className = "allowlist-row-label";
    name.textContent = label;
    r.appendChild(name);

    const right = document.createElement("span");
    right.className = "learned-row-right";
    const l = lean(score);
    const badge = document.createElement("span");
    badge.className = `learned-badge ${l.cls}`;
    badge.textContent = l.text;
    right.appendChild(badge);

    const forget = document.createElement("button");
    forget.type = "button";
    forget.className = "allowlist-remove";
    forget.setAttribute("aria-label", `Forget ${label}`);
    forget.title = "Forget this";
    forget.textContent = "×";
    forget.addEventListener("click", () => {
      onForget();
      refresh();
    });
    right.appendChild(forget);
    r.appendChild(right);
    return r;
  }

  // No-op until init() (which app.js only calls once DB.init() resolves) -- the Privacy tab can be
  // opened while the database is still loading.
  function refresh() {
    if (!els.types) return;
    const { tools, keywords } = ResourceFeedback.profile();
    els.types.innerHTML = "";
    els.keywords.innerHTML = "";

    const toolRows = Object.entries(tools).sort((a, b) => b[1].score - a[1].score);
    for (const [tool, s] of toolRows) {
      const label = ResourceFeedback.TOOL_LABELS[tool] || tool;
      els.types.appendChild(row(label, s.score, () => ResourceFeedback.forgetTool(tool)));
    }

    // Strongest leanings first, either direction; "mixed" keywords are left out to keep this short.
    const kwRows = Object.entries(keywords)
      .filter(([, s]) => Math.abs(s.score) >= LEAN)
      .sort((a, b) => Math.abs(b[1].score) - Math.abs(a[1].score))
      .slice(0, MAX_KEYWORDS * 2);
    for (const [k, s] of kwRows) {
      els.keywords.appendChild(row(k.charAt(0).toUpperCase() + k.slice(1), s.score, () => ResourceFeedback.forgetKeyword(k)));
    }

    els.empty.hidden = toolRows.length > 0;
    els.typesTitle.hidden = !toolRows.length;
    els.keywordsTitle.hidden = !kwRows.length;
    els.clear.hidden = !toolRows.length;
  }

  return { init, refresh };
})();
