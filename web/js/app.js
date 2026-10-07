(function () {
  const chat = document.getElementById("chat");
  const messageList = document.getElementById("messageList");
  const emptyState = document.getElementById("emptyState");
  const form = document.getElementById("composerForm");
  const input = document.getElementById("composerInput");
  const sendBtn = document.getElementById("sendBtn");
  const clearBtn = document.getElementById("clearBtn");
  const crisisBtn = document.getElementById("crisisBtn");
  const bannerCrisisLink = document.getElementById("bannerCrisisLink");
  const instructionsBtn = document.getElementById("instructionsBtn");

  const welcomeOverlay = document.getElementById("welcomeOverlay");
  const welcomeContinue = document.getElementById("welcomeContinue");
  const crisisOverlay = document.getElementById("crisisOverlay");
  const crisisClose = document.getElementById("crisisClose");
  const crisisModalList = document.getElementById("crisisModalList");
  const instructionsOverlay = document.getElementById("instructionsOverlay");
  const instructionsClose = document.getElementById("instructionsClose");
  const instructionsGoToPrivacyBtn = document.getElementById("instructionsGoToPrivacyBtn");

  const tplUser = document.getElementById("tpl-message-user");
  const tplAgent = document.getElementById("tpl-message-agent");
  const tplTool = document.getElementById("tpl-tool-card");
  const tplCrisisCard = document.getElementById("tpl-crisis-card");
  const tplCrisisLine = document.getElementById("tpl-crisis-line");

  const connStatus = document.getElementById("connStatus");
  const aiPanel = document.getElementById("aiPanel");
  const aiPanelText = document.getElementById("aiPanelText");
  const aiProgress = document.getElementById("aiProgress");
  const aiProgressBar = document.getElementById("aiProgressBar");
  const aiPanelActions = document.getElementById("aiPanelActions");
  const aiPrimaryBtn = document.getElementById("aiPrimaryBtn");
  const aiDismissBtn = document.getElementById("aiDismissBtn");

  const LOCKED_PLACEHOLDERS = {
    checking: "Checking your device…",
    available: "Download Reclaim's AI to start chatting",
    downloading: "Downloading Reclaim's AI…",
    loading: "Getting Reclaim's AI ready…",
    error: "Reclaim's AI isn't ready yet",
  };

  const LOCKED_NOTE = "Chat unlocks once it's ready. Crisis resources above always work.";
  // null: panel follows the AI's state; true: opened from the badge; false: dismissed.
  let aiPanelWanted = null;

  // Chat takes no input until the on-device model is ready. "unsupported" is the one exception:
  // a device with no WebGPU can never download a usable model, so locking it out would mean no
  // chat at all -- it keeps the scripted Basic mode instead.
  function chatLocked() {
    const state = LocalModel.getStatus().state;
    return state !== "ready" && state !== "unsupported";
  }

  function renderAiStatus(s) {
    const pct = Math.round(s.progress * 100);
    const busy = s.state === "downloading" || s.state === "loading";
    const locked = chatLocked();
    updateSendState();

    connStatus.dataset.state = s.state === "ready" ? "online" : s.state;
    connStatus.querySelector(".conn-label").textContent = {
      checking: "Checking…",
      unsupported: "Basic mode",
      available: "Download needed",
      downloading: `Downloading ${pct}%`,
      loading: "Getting ready…",
      ready: "Reclaim AI",
      error: "Download needed",
    }[s.state];
    connStatus.title =
      s.state === "ready" ? "Reclaim's AI runs privately on this device. Your conversations never leave it." : "About Reclaim's AI";

    const panel = {
      unsupported: {
        text: `This device can't run Reclaim's AI. ${s.detail} Instead, a simpler built-in guide answers, and crisis resources always work.`,
        dismiss: "OK",
      },
      available: {
        text: `Reclaim's AI runs privately on this device, so your conversations never leave it. To chat, download it once: about ${s.downloadMB >= 1000 ? `${Number((s.downloadMB / 1000).toFixed(1))} GB` : `${s.downloadMB} MB`} (Wi-Fi recommended).`,
        primary: "Download",
      },
      downloading: { text: `Downloading Reclaim's AI… ${pct}%. ${LOCKED_NOTE} You can keep using the rest of the app meanwhile.` },
      loading: { text: "Getting Reclaim's AI ready…" },
      error: { text: `${s.detail} ${LOCKED_NOTE}`, primary: "Try again" },
    }[s.state];

    // While chat is locked the panel is the only thing explaining why, so it can't be dismissed.
    const show = !!panel && (busy || locked || (aiPanelWanted === null ? s.state === "available" || s.state === "error" : aiPanelWanted));
    aiPanel.hidden = !show;
    if (!show) return;
    aiPanelText.textContent = panel.text;
    aiProgress.hidden = !busy;
    aiProgressBar.style.width = `${pct}%`;
    aiPanelActions.hidden = busy;
    aiPrimaryBtn.hidden = !panel.primary;
    aiPrimaryBtn.textContent = panel.primary || "";
    aiDismissBtn.hidden = locked;
    aiDismissBtn.textContent = panel.dismiss || "Close";
  }

  connStatus.addEventListener("click", () => {
    aiPanelWanted = aiPanel.hidden;
    renderAiStatus(LocalModel.getStatus());
  });
  aiDismissBtn.addEventListener("click", () => {
    aiPanelWanted = false;
    renderAiStatus(LocalModel.getStatus());
  });
  aiPrimaryBtn.addEventListener("click", () => {
    aiPanelWanted = null;
    LocalModel.start();
  });

  function createAgent() {
    return new ReclaimAgent();
  }

  // Provider API keys saved by older versions: no UI can remove them anymore.
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith("reclaim_api_key_") || k.startsWith("reclaim_model_") || k === "reclaim_agent_provider")
      .forEach((k) => localStorage.removeItem(k));
  } catch (e) {}

  let agent = createAgent();
  let busy = true; // stays true (composer disabled) until the database is ready
  let dbReady = false;

  // ---- View navigation (Chat / Check-In / Insights) ----

  // index.html's <head> sets this too; repeated here in case Capacitor's bridge wasn't injected yet then.
  if (window.Capacitor?.isNativePlatform?.()) document.documentElement.classList.add("is-native");

  const navItems = Array.from(document.querySelectorAll(".nav-item"));
  const viewPanels = Array.from(document.querySelectorAll("[data-view-panel]"));

  function showView(name) {
    navItems.forEach((btn) => btn.classList.toggle("active", btn.dataset.view === name));
    viewPanels.forEach((panel) => {
      panel.hidden = panel.dataset.viewPanel !== name;
    });
    if (name === "home") HomeView.refresh();
    if (name === "checkin") CheckInView.renderRecentList();
    if (name === "insights") InsightsView.refresh();
    if (name === "privacy") {
      PermissionsView.refresh();
      AllowlistView.refresh();
      BrowserTrackingView.refresh();
      LearnedView.refresh();
      refreshTrackingToggle();
    }
  }

  // NightlyCheckinActionReceiver (native) writes this when a notification action is actually
  // tapped -- see its own and NightlyCheckinWorker's comments for why the flag only gets set on a
  // real tap, and why this needs a native round-trip at all (the WebView isn't loaded when the
  // notification fires, so the check-in can't be logged directly from there).
  async function checkPendingNightlyAction() {
    if (typeof LocalSignals === "undefined" || !LocalSignals.available()) return;
    const action = await LocalSignals.getPendingNightlyAction();
    if (action === "quick_resisted") {
      CheckInStore.add({ timestamp: new Date().toISOString(), type: "resisted", tags: [] });
      if (typeof RiskProfile !== "undefined") RiskProfile.syncToNative();
    } else if (action === "open_checkin") {
      showView("checkin");
    }
  }

  // MainActivity.handleRiskIntent writes this when the risk-nudge notification's "Read a verse"
  // action specifically (not a body tap or the "Find resources" button inside the popup) is what
  // opened the app -- the whole point of that button is to skip the usual risk-alert detail popup
  // and land straight in Chat with a scripture request already sent, so the button does what it
  // says instead of just reopening the app onto the same screen a body tap would. Uses the exact
  // same trigger text as the "Find a verse" suggestion chip (index.html) so ResourcePicker
  // routes it the identical, already-verified way. Must run (and be checked) before
  // RiskAlertView.checkPending() -- MainActivity already cleared pending_risk_alert for this case,
  // but ordering it first keeps that guarantee explicit here too, not just implicit in native.
  async function checkPendingVerseRequest() {
    if (typeof LocalSignals === "undefined" || !LocalSignals.available()) return false;
    const pending = await LocalSignals.getPendingVerseRequest();
    if (!pending) return false;
    return submitVerseRequest();
  }

  // Shared by the Android notification action and the browser extension's: land in Chat with a
  // scripture request already sent (or on Home if the chat model isn't downloaded yet).
  function submitVerseRequest() {
    if (chatLocked()) {
      // The auto-submit below would be refused while the model isn't downloaded; Home's "Today's
      // Verse" card is the same verse from YouVersion, so land there instead.
      showView("home");
      return true;
    }
    showView("chat");
    input.value = "Can you share a Bible verse with me?";
    autoResize();
    updateSendState();
    form.requestSubmit();
    return true;
  }

  // Web version: the browser extension (extension/) holds the same three pending items the Android
  // native side does -- a risk alert, a nightly-check-in action, a verse request -- written when a
  // browser notification was clicked. Consumed once (the extension clears them on read). Runs at
  // boot, whenever the tab regains focus, and when the extension pushes "something is pending".
  async function checkPendingWeb() {
    if (typeof WebTracker === "undefined" || !WebTracker.available() || !dbReady) return;
    const pending = await WebTracker.takePending();
    if (pending.nightly === "quick_resisted") {
      CheckInStore.add({ timestamp: new Date().toISOString(), type: "resisted", tags: [] });
      RiskProfile.syncToNative();
    } else if (pending.nightly === "open_checkin") {
      showView("checkin");
    }
    if (pending.verse) submitVerseRequest();
    else if (pending.riskAlert) RiskAlertView.render(pending.riskAlert);
  }

  // MainActivity is singleTask, so tapping a notification while the app is already alive in the
  // background just re-foregrounds the existing WebView instead of reloading it -- the DB.init()
  // boot call below never re-runs in that case, so neither pending-flag check would ever fire
  // again until the next cold start. Capacitor fires this standard lifecycle event every time the
  // app returns to foreground (cold boot included), so check both there too. Confirmed via real
  // device testing this was needed: without it, "Tell me more" tapped against an already-running
  // app silently left the flag unconsumed and never navigated to Check-In.
  document.addEventListener("resume", async () => {
    if (busy) return;
    checkPendingNightlyAction();
    const wentToVerse = await checkPendingVerseRequest();
    if (!wentToVerse && typeof RiskAlertView !== "undefined") RiskAlertView.checkPending();
  });

  navItems.forEach((btn) => {
    btn.addEventListener("click", () => showView(btn.dataset.view));
  });

  PermissionsView.init();
  AllowlistView.init();
  BrowserTrackingView.init();

  // Browser extension (web version): detected asynchronously, possibly after boot, so everything
  // that mirrors state to it hooks in here as well as running at boot below.
  WebTracker.onAvailable(() => {
    RiskProfile.syncToNative();
    BrowserTrackingView.refresh();
    HomeView.refresh();
    checkPendingWeb();
  });
  WebTracker.onPending(() => checkPendingWeb());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      WebTracker.appOpened(); // "recently opened Reclaim" is a protective risk factor
      checkPendingWeb();
    }
  });

  LocalModel.onChange(renderAiStatus);
  LocalModel.init();
  DB.init()
    .then(() => {
      CheckInView.init();
      InsightsView.init();
      HomeView.init();
      PreferencesView.init();
      RiskAlertView.init();
      LearnedView.init(); // reads resource_feedback, so it has to wait for DB.init() like the views above
      checkPendingNightlyAction();
      DebugTestPanel.init(); // TEMPORARY -- see debugTestPanel.js
      // Covers data that predates RiskNudgeMonitor's native mirror, or check-ins logged before
      // this boot -- ordinary saves/check-ins push this themselves (see userPreferencesStore.js,
      // checkinStore.js), this just catches anyone already past that.
      RiskProfile.syncToNative();
      ensureBackgroundSchedulingCurrent();
      UsageAnalytics.pingIfNeeded(); // minimal privacy-safe "how many/how often" counter -- see its own header
      busy = false;
      dbReady = true;
      updateSendState();
      WebTracker.init().then((found) => {
        HomeView.extensionProbeDone();
        if (!found) return;
        WebTracker.appOpened();
        RiskProfile.syncToNative();
        BrowserTrackingView.refresh();
        checkPendingWeb();
      });
      checkPendingVerseRequest().then((wentToVerse) => {
        if (!wentToVerse) RiskAlertView.checkPending();
      });
    })
    .catch((err) => {
      console.error("Failed to initialize local database", err);
      input.placeholder = "Something went wrong loading the app — try restarting.";
    });

  // ---- Welcome / crisis modals ----

  // Bump when the notice's substance changes so people who already dismissed it see it again.
  const WELCOME_VERSION = "3";

  function showWelcomeIfNeeded() {
    let seen = false;
    try {
      seen = localStorage.getItem("reclaim_welcome_seen") === WELCOME_VERSION;
    } catch (e) {
      /* private browsing / storage blocked — show every time */
    }
    if (!seen) welcomeOverlay.classList.add("visible");
  }

  welcomeContinue.addEventListener("click", () => {
    welcomeOverlay.classList.remove("visible");
    try {
      localStorage.setItem("reclaim_welcome_seen", WELCOME_VERSION);
    } catch (e) {}
    // DB.init() is idempotent (resolves immediately if already loaded) — this just guarantees
    // PreferencesView.init() has run before we try to open it, even if DB was still loading.
    DB.init().then(() => PreferencesView.open("onboarding"));
  });

  function openCrisisModal() {
    crisisModalList.innerHTML = "";
    personalCrisisLines().forEach((line) => crisisModalList.appendChild(buildCrisisLine(line)));
    CRISIS_LINES.forEach((line) => crisisModalList.appendChild(buildCrisisLine(line)));
    crisisOverlay.classList.add("visible");
  }

  // Accountability partner / pastor, from UserPreferencesStore, shown above the fixed national
  // lines — only when a phone number was actually entered. Wrapped in try/catch rather than a
  // readiness check: this is only ever reached from a click (crisisBtn/bannerCrisisLink), well
  // after boot, so DB should already be loaded, but a crisis-help button must never throw.
  function personalCrisisLines() {
    try {
      const prefs = UserPreferencesStore.get();
      const lines = [];
      if (prefs.accountability_phone) {
        lines.push({
          name: prefs.accountability_name || "Your accountability partner",
          phone: prefs.accountability_phone,
          detail: "Reach out — that's exactly what this relationship is for.",
        });
      }
      if (prefs.accountability_phone_2) {
        lines.push({
          name: prefs.accountability_name_2 || "Your accountability partner",
          phone: prefs.accountability_phone_2,
          detail: "Reach out — that's exactly what this relationship is for.",
        });
      }
      if (prefs.pastor_phone) {
        lines.push({
          name: prefs.pastor_name || "Your pastor",
          phone: prefs.pastor_phone,
          detail: "",
        });
      }
      return lines;
    } catch (e) {
      return [];
    }
  }

  function buildCrisisLine(line) {
    const node = tplCrisisLine.content.firstElementChild.cloneNode(true);
    node.querySelector(".crisis-line-name").textContent = line.name;
    const phoneEl = node.querySelector(".crisis-line-phone");
    phoneEl.textContent = line.phone;
    phoneEl.href = `tel:${line.phone.replace(/[^\d+]/g, "")}`;
    node.querySelector(".crisis-line-detail").textContent = line.detail;
    return node;
  }

  crisisBtn.addEventListener("click", openCrisisModal);
  bannerCrisisLink.addEventListener("click", openCrisisModal);
  crisisClose.addEventListener("click", () => crisisOverlay.classList.remove("visible"));

  instructionsBtn.addEventListener("click", () => instructionsOverlay.classList.add("visible"));
  instructionsClose.addEventListener("click", () => instructionsOverlay.classList.remove("visible"));
  instructionsGoToPrivacyBtn.addEventListener("click", () => {
    instructionsOverlay.classList.remove("visible");
    // No exposed cross-module navigation API -- same reasoning RiskAlertView's "Find resources"
    // button and PreferencesView's "Add one now" button already used.
    const privacyNav = document.querySelector('.nav-item[data-view="privacy"]');
    if (privacyNav) privacyNav.click();
  });

  showWelcomeIfNeeded();

  // ---- Chat rendering ----

  function autoResize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
  }

  function updateSendState() {
    const locked = chatLocked();
    input.disabled = locked;
    document.querySelectorAll(".suggestion-chip").forEach((chip) => {
      chip.disabled = locked;
    });
    input.placeholder = locked
      ? LOCKED_PLACEHOLDERS[LocalModel.getStatus().state] || LOCKED_PLACEHOLDERS.available
      : dbReady
        ? "Tell me what's going on…"
        : "Loading…";
    sendBtn.disabled = busy || locked || input.value.trim().length === 0;
  }

  function scrollToBottom() {
    chat.scrollTop = chat.scrollHeight;
  }

  function hideEmptyState() {
    if (emptyState) emptyState.style.display = "none";
  }

  function addUserMessage(text) {
    const node = tplUser.content.firstElementChild.cloneNode(true);
    node.querySelector(".bubble").textContent = text;
    messageList.appendChild(node);
    scrollToBottom();
  }

  function addAgentMessage() {
    const node = tplAgent.content.firstElementChild.cloneNode(true);
    messageList.appendChild(node);
    scrollToBottom();
    return {
      root: node,
      content: node.querySelector(".agent-content"),
      bubble: node.querySelector(".bubble"),
    };
  }

  function addTypingIndicator(container) {
    const el = document.createElement("div");
    el.className = "typing-indicator";
    el.innerHTML = '<div class="bubble"><span class="typing-dots"><span></span><span></span><span></span></span></div>';
    container.appendChild(el);
    scrollToBottom();
    return el;
  }

  function addCrisisCard(container, beforeEl) {
    const node = tplCrisisCard.content.firstElementChild.cloneNode(true);
    const list = node.querySelector(".crisis-card-list");
    CRISIS_LINES.forEach((line) => list.appendChild(buildCrisisLine(line)));
    container.insertBefore(node, beforeEl);
    scrollToBottom();
  }

  function addToolCard(container, name, input, beforeEl) {
    const node = tplTool.content.firstElementChild.cloneNode(true);
    node.querySelector(".tool-name").textContent = formatToolName(name);
    node.querySelector(".tool-summary").textContent = summarizeInput(name, input);

    const header = node.querySelector(".tool-card-header");
    header.addEventListener("click", () => {
      const expanded = node.getAttribute("data-expanded") === "true";
      node.setAttribute("data-expanded", expanded ? "false" : "true");
    });

    container.insertBefore(node, beforeEl);
    scrollToBottom();
    return node;
  }

  function completeToolCard(node, name, output, ctx) {
    node.setAttribute("data-status", "done");
    node.setAttribute("data-expanded", "true");
    const resultEl = node.querySelector(".tool-result");
    resultEl.appendChild(renderToolResult(name, output, ctx));
    scrollToBottom();
  }

  function formatToolName(name) {
    const labels = {
      scripture_search: "Scripture Search",
      bible_plan_finder: "Bible Plan Finder",
      devotional_finder: "Devotional Finder",
      article_finder: "Article Finder",
      coping_toolkit: "Coping Toolkit",
      small_group_finder: "Small Group Finder",
      accountability_match: "Accountability Match",
      sermon_library: "Sermon Library",
      counseling_directory: "Counseling Directory",
      encouragement: "Encouragement",
    };
    return labels[name] || name.split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
  }

  function summarizeInput(name, input) {
    if (input && input.theme) return `theme: ${input.theme}`;
    if (input && input.query) return input.query.length > 48 ? input.query.slice(0, 48) + "…" : input.query;
    return "";
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function sampleTag() {
    return el("span", "sample-tag", "Sample");
  }

  function sampleTagIf(row) {
    return row.is_sample ? [document.createTextNode(" "), sampleTag()] : [];
  }

  // Shared by every Supabase-backed resource list (small groups, sermons, articles, counseling
  // centers) for the network-down/Supabase-unreachable case -- ReclaimAgent's path had no handling
  // for this at all before (only ResourcesAgent's Basic-mode path did, and only for small groups).
  function unreachableCard(label) {
    const wrap = document.createElement("div");
    wrap.appendChild(el("div", "resource-item", `Couldn't reach the ${label} right now — try again once you're online.`));
    return wrap;
  }

  function resourceLink(url) {
    const a = document.createElement("a");
    a.className = "resource-contact";
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = url.replace(/^https?:\/\//, "");
    return a;
  }

  // Material Design "thumb_up"/"thumb_down" icon paths (Apache 2.0).
  const THUMB_UP_PATH =
    "M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z";
  const THUMB_DOWN_PATH =
    "M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 23l6.59-6.59c.36-.36.58-.86.58-1.41V5c0-1.1-.9-2-2-2zm4 0v12h4V3h-4z";

  function thumbButton(path, label) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "feedback-btn";
    btn.setAttribute("aria-label", label);
    btn.setAttribute("aria-pressed", "false");
    btn.title = label;
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="${path}"/></svg>`;
    return btn;
  }

  // Helpful / not helpful on one card. Only in on-device AI mode (ctx.feedback, set by
  // ReclaimAgent) and never on the accountability partner -- see resourceFeedback.js for what a
  // rating teaches. Tapping the pressed thumb again undoes the rating.
  function addFeedbackRow(card, name, item, ctx) {
    if (!ctx || !ctx.feedback || !item || typeof ResourceFeedback === "undefined" || !ResourceFeedback.rateable(name)) return;
    const entry = ResourceFeedback.describe(name, item);
    let rowId = null;
    let current = 0;

    const bar = el("div", "feedback-row");
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", "Was this helpful?");
    bar.appendChild(el("span", "feedback-label", "Helpful?"));
    const up = thumbButton(THUMB_UP_PATH, "Helpful");
    const down = thumbButton(THUMB_DOWN_PATH, "Not helpful");
    const set = (rating) => {
      if (rating === current) {
        ResourceFeedback.remove(rowId);
        rowId = null;
        current = 0;
      } else {
        rowId = ResourceFeedback.rate(rowId, entry, rating);
        current = rating;
      }
      up.setAttribute("aria-pressed", String(current === 1));
      down.setAttribute("aria-pressed", String(current === -1));
    };
    up.addEventListener("click", () => set(1));
    down.addEventListener("click", () => set(-1));
    bar.appendChild(up);
    bar.appendChild(down);
    card.appendChild(bar);
  }

  function renderToolResult(name, output, ctx) {
    const wrap = document.createElement("div");

    if (name === "scripture_search") {
      // YouVersion Bible display (youversion.js) whenever it's available -- including the version's
      // copyright attribution the YouVersion license requires -- else the local verse text.
      if (output.youversion && typeof YouVersion !== "undefined") {
        const card = el("div", "resource-item resource-item-yv");
        if (output.todaysVerse) card.appendChild(el("div", "resource-kicker", "Today's Verse"));
        card.appendChild(YouVersion.render(output.youversion));
        addFeedbackRow(card, name, output, ctx);
        wrap.appendChild(card);
        return wrap;
      }
      const card = el("div", "resource-item");
      card.appendChild(el("div", "resource-title", output.title));
      card.appendChild(el("blockquote", "resource-quote", output.body));
      addFeedbackRow(card, name, output, ctx);
      wrap.appendChild(card);
      return wrap;
    }

    if (name === "devotional_finder") {
      const card = el("div", "resource-item");
      const head = el("div", "resource-title");
      head.appendChild(document.createTextNode(output.title));
      sampleTagIf(output).forEach((n) => head.appendChild(n));
      card.appendChild(head);
      card.appendChild(el("div", "resource-line", output.body));
      addFeedbackRow(card, name, output, ctx);
      wrap.appendChild(card);
      return wrap;
    }

    if (name === "bible_plan_finder") {
      output.plans.forEach((p) => {
        const card = el("div", "resource-item");
        const head = el("div", "resource-title");
        head.appendChild(document.createTextNode(p.title));
        sampleTagIf(p).forEach((n) => head.appendChild(n));
        card.appendChild(head);
        card.appendChild(el("div", "resource-line", p.body));
        card.appendChild(el("div", "resource-line", `${p.days.length}-day plan · starts with ${p.days[0].reference}`));
        addFeedbackRow(card, name, p, ctx);
        wrap.appendChild(card);
      });
      return wrap;
    }

    if (name === "article_finder") {
      if (output.articles === null) return unreachableCard("article library");
      output.articles.forEach((a) => {
        const card = el("div", "resource-item");
        const head = el("div", "resource-title");
        head.appendChild(document.createTextNode(a.title));
        sampleTagIf(a).forEach((n) => head.appendChild(n));
        card.appendChild(head);
        if (a.subtitle) card.appendChild(el("div", "resource-line", a.subtitle));
        card.appendChild(el("div", "resource-line", a.body));
        if (a.url) card.appendChild(resourceLink(a.url));
        addFeedbackRow(card, name, a, ctx);
        wrap.appendChild(card);
      });
      return wrap;
    }

    if (name === "coping_toolkit") {
      output.mechanisms.forEach((m) => {
        const card = el("div", "resource-item");
        card.appendChild(el("div", "resource-title", m.title));
        card.appendChild(el("div", "resource-line", m.body));
        addFeedbackRow(card, name, m, ctx);
        wrap.appendChild(card);
      });
      return wrap;
    }

    if (name === "small_group_finder") {
      if (output.groups === null) return unreachableCard("group directory");
      output.groups.forEach((g) => {
        const card = el("div", "resource-item");
        const head = el("div", "resource-title");
        head.appendChild(document.createTextNode(g.title + " "));
        sampleTagIf(g).forEach((n) => head.appendChild(n));
        card.appendChild(head);
        card.appendChild(el("div", "resource-line", `${g.subtitle} · ${g.area}`));
        if (g.distanceMeters != null) {
          const miles = Math.round(g.distanceMeters / 1609.34);
          card.appendChild(el("div", "resource-line", `~${miles < 1 ? "<1" : miles} mi from your saved home location`));
        }
        card.appendChild(el("div", "resource-line", g.body));
        card.appendChild(el("div", "resource-contact", g.contact));
        addFeedbackRow(card, name, g, ctx);
        wrap.appendChild(card);
      });
      return wrap;
    }

    if (name === "accountability_match") {
      if (output.contacts && output.contacts.length) {
        output.contacts.forEach((c) => {
          const card = el("div", "resource-item");
          card.appendChild(el("div", "resource-title", c.name));
          const call = document.createElement("a");
          call.className = "resource-contact";
          call.href = `tel:${c.phone.replace(/[^\d+]/g, "")}`;
          call.textContent = `Call ${c.name}`;
          card.appendChild(call);
          wrap.appendChild(card);
        });
      } else {
        const card = el("div", "resource-item");
        card.appendChild(el("div", "resource-line", "You haven't added an accountability partner yet."));
        const addBtn = document.createElement("button");
        addBtn.type = "button";
        addBtn.className = "secondary-btn";
        addBtn.style.marginTop = "8px";
        addBtn.textContent = "Add one now";
        addBtn.addEventListener("click", () => PreferencesView.open("edit"));
        card.appendChild(addBtn);
        wrap.appendChild(card);
      }
      return wrap;
    }

    if (name === "sermon_library") {
      if (output.sermons === null) return unreachableCard("sermon library");
      output.sermons.forEach((s) => {
        const card = el("div", "resource-item");
        const head = el("div", "resource-title");
        head.appendChild(document.createTextNode(s.title + " "));
        sampleTagIf(s).forEach((n) => head.appendChild(n));
        card.appendChild(head);
        if (s.subtitle) card.appendChild(el("div", "resource-line", s.subtitle));
        if (s.duration_min) card.appendChild(el("div", "resource-line", `${s.duration_min} min`));
        if (s.url) card.appendChild(resourceLink(s.url));
        addFeedbackRow(card, name, s, ctx);
        wrap.appendChild(card);
      });
      return wrap;
    }

    if (name === "counseling_directory") {
      if (output.centers === null) return unreachableCard("counseling directory");
      output.centers.forEach((c) => {
        const card = el("div", "resource-item");
        const head = el("div", "resource-title");
        head.appendChild(document.createTextNode(c.title + " "));
        sampleTagIf(c).forEach((n) => head.appendChild(n));
        card.appendChild(head);
        card.appendChild(el("div", "resource-line", [c.subtitle, c.area].filter(Boolean).join(" · ")));
        if (c.contact) card.appendChild(el("div", "resource-contact", c.contact));
        else if (c.url) card.appendChild(resourceLink(c.url));
        addFeedbackRow(card, name, c, ctx);
        wrap.appendChild(card);
      });
      return wrap;
    }

    if (name === "encouragement") {
      wrap.appendChild(el("div", "resource-item", output.message));
      return wrap;
    }

    const pre = el("pre", "tool-input");
    pre.textContent = JSON.stringify(output, null, 2);
    wrap.appendChild(pre);
    return wrap;
  }

  // Bubbles render plain text, and the model sometimes writes Markdown anyway.
  function stripMarkdown(text) {
    return text
      .replace(/\[([^\]\n]+)\]\(([^)\s]*)\)/g, (m, label, url) => (/^https?:\/\//i.test(url) ? `${label} (${url})` : label))
      .replace(/\*\*/g, "")
      .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
      .replace(/^[ \t]*>[ \t]?/gm, "")
      .replace(/^([ \t]*)\*[ \t]+/gm, "$1- ")
      .replace(/\*([^*\n]+)\*/g, "$1");
  }

  async function handleSend(text) {
    hideEmptyState();
    addUserMessage(text);
    input.value = "";
    autoResize();
    busy = true;
    updateSendState();

    const agentMsg = addAgentMessage();
    const typing = addTypingIndicator(agentMsg.content);
    let typingRemoved = false;
    let rawReply = "";

    const removeTyping = () => {
      if (!typingRemoved) {
        typing.remove();
        typingRemoved = true;
      }
    };

    try {
      await agent.send(text, {
        onCrisis: () => {
          removeTyping();
          addCrisisCard(agentMsg.content, agentMsg.bubble);
        },
        onToolCallStart: ({ name, input, feedback }) => {
          removeTyping();
          agentMsg.content._activeTool = {
            node: addToolCard(agentMsg.content, name, input, agentMsg.bubble),
            name,
            ctx: { input, feedback: !!feedback },
          };
        },
        onToolCallEnd: ({ output }) => {
          const active = agentMsg.content._activeTool;
          if (active) completeToolCard(active.node, active.name, output, active.ctx);
        },
        onTextDelta: (chunk) => {
          removeTyping();
          rawReply += chunk;
          agentMsg.bubble.textContent = stripMarkdown(rawReply);
          scrollToBottom();
        },
        onDone: () => {
          removeTyping();
        },
      });
    } finally {
      busy = false;
      updateSendState();
      input.focus();
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || busy || chatLocked()) return;
    handleSend(text);
  });

  input.addEventListener("input", () => {
    autoResize();
    updateSendState();
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  document.querySelectorAll(".suggestion-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      input.value = chip.dataset.suggest;
      autoResize();
      updateSendState();
      form.requestSubmit();
    });
  });

  clearBtn.addEventListener("click", () => {
    if (busy) return;
    messageList.innerHTML = "";
    if (emptyState) emptyState.style.display = "";
    agent = createAgent();
  });

  // ---- Privacy view: background sampling toggle ----

  const trackingToggleBtn = document.getElementById("trackingToggleBtn");

  // BackgroundSamplerPlugin.enable() is the only place that schedules WorkManager jobs, and it
  // only ever ran from the toggle button's click handler -- a one-time action. Real bug this
  // caught: NightlyCheckinWorker's scheduling was added to enable() well after tracking had
  // already been turned on on a real device, and since the toggle was already "on" (disabled),
  // nothing ever called enable() again to pick up the new schedule -- it silently never fired,
  // ever, confirmed via dumpsys jobscheduler showing only the baseline sampler's job, none for
  // the nightly one. Re-invoking enable() at every boot fixes this and any future addition the
  // same way -- it's idempotent (KEEP policy, see its own comment) and never opts anyone in who
  // hasn't already granted tracking; isScheduled() (checked first) is what makes that safe.
  async function ensureBackgroundSchedulingCurrent() {
    if (typeof BackgroundSampler === "undefined" || !BackgroundSampler.available()) return;
    try {
      const alreadyOn = await BackgroundSampler.isScheduled();
      if (alreadyOn) await BackgroundSampler.enable();
    } catch (e) {
      // Best-effort -- a failure here just means scheduling isn't re-confirmed this boot, not a
      // reason to block startup.
    }
  }

  async function refreshTrackingToggle() {
    if (!BackgroundSampler.available()) {
      trackingToggleBtn.textContent = "Unavailable on this platform";
      trackingToggleBtn.disabled = true;
      return;
    }
    const scheduled = await BackgroundSampler.isScheduled();
    trackingToggleBtn.textContent = scheduled ? "Background sampling is on" : "Turn on background sampling";
    trackingToggleBtn.disabled = scheduled;
  }

  trackingToggleBtn.addEventListener("click", async () => {
    trackingToggleBtn.disabled = true;
    trackingToggleBtn.textContent = "Turning on…";
    await BackgroundSampler.enable();
    refreshTrackingToggle();
  });

  updateSendState();
})();
