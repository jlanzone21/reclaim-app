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

  const welcomeOverlay = document.getElementById("welcomeOverlay");
  const welcomeContinue = document.getElementById("welcomeContinue");
  const crisisOverlay = document.getElementById("crisisOverlay");
  const crisisClose = document.getElementById("crisisClose");
  const crisisModalList = document.getElementById("crisisModalList");

  const tplUser = document.getElementById("tpl-message-user");
  const tplAgent = document.getElementById("tpl-message-agent");
  const tplTool = document.getElementById("tpl-tool-card");
  const tplCrisisCard = document.getElementById("tpl-crisis-card");
  const tplCrisisLine = document.getElementById("tpl-crisis-line");

  const connStatus = document.getElementById("connStatus");

  const CONN_STATES = {
    checking: { label: "Connecting…", title: "" },
    online: { label: "Reclaim AI", title: "" },
    basic: {
      label: "Basic mode",
      title: "Reclaim's AI can't be reached right now, so a simpler built-in guide is answering. Crisis resources always work.",
    },
  };

  function updateConnStatus(state) {
    connStatus.dataset.state = state;
    connStatus.querySelector(".conn-label").textContent = CONN_STATES[state].label;
    connStatus.title = CONN_STATES[state].title;
  }

  function createAgent() {
    return new ReclaimAgent({ onStatus: updateConnStatus });
  }

  // Provider API keys saved by older versions: no UI can remove them anymore.
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith("reclaim_api_key_") || k.startsWith("reclaim_model_") || k === "reclaim_agent_provider")
      .forEach((k) => localStorage.removeItem(k));
  } catch (e) {}

  let agent = createAgent();
  let busy = true; // stays true (composer disabled) until the database is ready

  // ---- View navigation (Chat / Check-In / Insights) ----

  const navItems = Array.from(document.querySelectorAll(".nav-item"));
  const viewPanels = Array.from(document.querySelectorAll("[data-view-panel]"));

  function showView(name) {
    navItems.forEach((btn) => btn.classList.toggle("active", btn.dataset.view === name));
    viewPanels.forEach((panel) => {
      panel.hidden = panel.dataset.viewPanel !== name;
    });
    if (name === "checkin") CheckInView.renderRecentList();
    if (name === "insights") InsightsView.refresh();
  }

  navItems.forEach((btn) => {
    btn.addEventListener("click", () => showView(btn.dataset.view));
  });

  input.placeholder = "Loading…";
  updateConnStatus("checking");
  agent.checkStatus();
  DB.init()
    .then(() => {
      CheckInView.init();
      InsightsView.init();
      busy = false;
      input.placeholder = "Tell me what's going on…";
      updateSendState();
    })
    .catch((err) => {
      console.error("Failed to initialize local database", err);
      input.placeholder = "Something went wrong loading the app — try restarting.";
    });

  // ---- Welcome / crisis modals ----

  // Bump when the notice's substance changes so people who already dismissed it see it again.
  const WELCOME_VERSION = "2";

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
  });

  function openCrisisModal() {
    crisisModalList.innerHTML = "";
    CRISIS_LINES.forEach((line) => crisisModalList.appendChild(buildCrisisLine(line)));
    crisisOverlay.classList.add("visible");
  }

  function buildCrisisLine(line) {
    const node = tplCrisisLine.content.firstElementChild.cloneNode(true);
    node.querySelector(".crisis-line-name").textContent = line.name;
    node.querySelector(".crisis-line-phone").textContent = line.phone;
    node.querySelector(".crisis-line-detail").textContent = line.detail;
    return node;
  }

  crisisBtn.addEventListener("click", openCrisisModal);
  bannerCrisisLink.addEventListener("click", openCrisisModal);
  crisisClose.addEventListener("click", () => crisisOverlay.classList.remove("visible"));

  showWelcomeIfNeeded();

  // ---- Chat rendering ----

  function autoResize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
  }

  function updateSendState() {
    sendBtn.disabled = busy || input.value.trim().length === 0;
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

  function completeToolCard(node, name, output) {
    node.setAttribute("data-status", "done");
    node.setAttribute("data-expanded", "true");
    const resultEl = node.querySelector(".tool-result");
    resultEl.appendChild(renderToolResult(name, output));
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

  function renderToolResult(name, output) {
    const wrap = document.createElement("div");

    if (name === "scripture_search") {
      const card = el("div", "resource-item");
      card.appendChild(el("div", "resource-title", output.title));
      card.appendChild(el("blockquote", "resource-quote", output.body));
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
        wrap.appendChild(card);
      });
      return wrap;
    }

    if (name === "article_finder") {
      output.articles.forEach((a) => {
        const card = el("div", "resource-item");
        const head = el("div", "resource-title");
        head.appendChild(document.createTextNode(a.title));
        sampleTagIf(a).forEach((n) => head.appendChild(n));
        card.appendChild(head);
        if (a.subtitle) card.appendChild(el("div", "resource-line", a.subtitle));
        card.appendChild(el("div", "resource-line", a.body));
        wrap.appendChild(card);
      });
      return wrap;
    }

    if (name === "coping_toolkit") {
      output.mechanisms.forEach((m) => {
        const card = el("div", "resource-item");
        card.appendChild(el("div", "resource-title", m.title));
        card.appendChild(el("div", "resource-line", m.body));
        wrap.appendChild(card);
      });
      return wrap;
    }

    if (name === "small_group_finder") {
      output.groups.forEach((g) => {
        const card = el("div", "resource-item");
        const head = el("div", "resource-title");
        head.appendChild(document.createTextNode(g.title + " "));
        sampleTagIf(g).forEach((n) => head.appendChild(n));
        card.appendChild(head);
        card.appendChild(el("div", "resource-line", `${g.subtitle} · ${g.area}`));
        card.appendChild(el("div", "resource-line", g.body));
        card.appendChild(el("div", "resource-contact", g.contact));
        wrap.appendChild(card);
      });
      return wrap;
    }

    if (name === "accountability_match") {
      output.programs.forEach((p) => {
        const card = el("div", "resource-item");
        const head = el("div", "resource-title");
        head.appendChild(document.createTextNode(p.title + " "));
        sampleTagIf(p).forEach((n) => head.appendChild(n));
        card.appendChild(head);
        card.appendChild(el("div", "resource-line", p.body));
        card.appendChild(el("div", "resource-contact", p.contact));
        wrap.appendChild(card);
      });
      return wrap;
    }

    if (name === "sermon_library") {
      output.sermons.forEach((s) => {
        const card = el("div", "resource-item");
        const head = el("div", "resource-title");
        head.appendChild(document.createTextNode(s.title + " "));
        sampleTagIf(s).forEach((n) => head.appendChild(n));
        card.appendChild(head);
        card.appendChild(el("div", "resource-line", s.subtitle));
        card.appendChild(el("div", "resource-line", `${s.duration_min} min`));
        wrap.appendChild(card);
      });
      return wrap;
    }

    if (name === "counseling_directory") {
      output.centers.forEach((c) => {
        const card = el("div", "resource-item");
        const head = el("div", "resource-title");
        head.appendChild(document.createTextNode(c.title + " "));
        sampleTagIf(c).forEach((n) => head.appendChild(n));
        card.appendChild(head);
        card.appendChild(el("div", "resource-line", `${c.subtitle} · ${c.area}`));
        card.appendChild(el("div", "resource-contact", c.contact));
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
        onToolCallStart: ({ name, input }) => {
          removeTyping();
          agentMsg.content._activeTool = { node: addToolCard(agentMsg.content, name, input, agentMsg.bubble), name };
        },
        onToolCallEnd: ({ output }) => {
          if (agentMsg.content._activeTool) {
            completeToolCard(agentMsg.content._activeTool.node, agentMsg.content._activeTool.name, output);
          }
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
    if (!text || busy) return;
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

  updateSendState();
})();
