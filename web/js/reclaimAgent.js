// Reclaim's AI agent: the on-device model (LocalModel) picks at most one resource from a fixed list, the app looks it up here, and the model writes a short reply that is checked before it's shown.
const RECLAIM_TOOL_NAMES = new Set(AGENT_TOOL_DEFS.map((t) => t.name));
const RECLAIM_ROUTER_SCHEMA = {
  type: "object",
  properties: {
    resource: { type: "string", enum: [...RECLAIM_TOOL_NAMES, "off_topic", "none"] },
    theme: { type: "string", enum: [...AGENT_THEME_ENUM, "none"] },
  },
  required: ["resource", "theme"],
};
const RECLAIM_HISTORY_MESSAGES = 6;
const RECLAIM_CLIP_CHARS = 600;
// Telling a struggling person "I can't help with that" is the worst failure here, so these words veto an off_topic routing.
const RECLAIM_ON_TOPIC =
  /\b(lonel|alone|isolat|stress|anxi|worr|sad|depress|down\b|low\b|angry|anger|mad\b|upset|frustrat|ashamed|shame|guilt|tempt|urge|crav|slip|relaps|fail|porn|lust|sex|masturb|god|jesus|christ|pray|faith|church|bible|forgiv|sleep|bored|tired|exhaust|hurt|scared|afraid|hopeless|wife|husband|girlfriend|boyfriend|spouse|marri|family|feel|struggl|addict|recover)/i;
const RECLAIM_OFF_TOPIC_REPLY =
  "I'm only here to help with recovery, faith, and finding support, so I can't help with that one. Is anything weighing on you today?";

const clip = (text, n = RECLAIM_CLIP_CHARS) => (text.length > n ? `${text.slice(0, n)}…` : text);

// The app, not the model, introduces each card: a small model asked to talk about specific resources misquotes or refuses them.
function cardIntro(name, theme) {
  const about = theme && theme !== "in-the-moment" ? ` about ${theme}` : "";
  return AGENT_TOOL_DEFS.find((t) => t.name === name).intro.replace("{about}", about);
}

// Small models invent verses, quotes, and contacts despite instructions, so any sentence containing one is dropped.
const RECLAIM_UNSAFE_SENTENCE = [
  /\b(?:[1-3]\s?)?[A-Z][a-z]+(?:\s(?:of\s)?[A-Z][a-z]+)?\s\d{1,3}:\d{1,3}/, // Bible reference, e.g. "1 John 4:16"
  /["“][^"”]{12,}["”]/, // quoted passage
  /\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/, // phone number
  /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|org|net|io|app)\b/i, // link or site
];

function cleanReply(text, cardShown) {
  const sentences = text.trim().split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((s) => !RECLAIM_UNSAFE_SENTENCE.some((re) => re.test(s))).slice(0, 3);
  if (kept.length) return kept.join(" ");
  return cardShown ? "" : "I'm glad you reached out. I'm here with you.";
}

class ReclaimAgent {
  constructor() {
    this.history = [];
    this.fallback = new ResourcesAgent();
    this._idCounter = 0;
  }

  async send(userText, handlers) {
    // Crisis detection must run before the model is involved and never depend on it.
    if (agentIsCrisis(userText)) {
      handlers.onCrisis({ lines: CRISIS_LINES });
      await agentStreamText(CRISIS_REPLY, handlers.onTextDelta);
      this._remember(userText, CRISIS_REPLY);
      handlers.onDone();
      return;
    }

    if (!LocalModel.isReady()) {
      await this.fallback.send(userText, handlers);
      return;
    }

    let shown = false;
    try {
      const pick = await this._route(userText);
      let reply;
      if (pick && pick.offTopic) {
        reply = RECLAIM_OFF_TOPIC_REPLY;
      } else {
        let intro = "";
        if (pick) {
          const id = `tool_${++this._idCounter}`;
          const input = pick.theme ? { theme: pick.theme } : {};
          shown = true;
          handlers.onToolCallStart({ id, name: pick.resource, input });
          handlers.onToolCallEnd({ id, output: executeAgentTool(pick.resource, input) });
          intro = cardIntro(pick.resource, pick.theme);
        }
        const messages = this._replyMessages(userText, intro);
        let raw = await LocalModel.streamChat(messages, { onDelta: () => {} });
        const previous = this.history.length ? this.history[this.history.length - 1].content : "";
        if (raw.trim() && previous.includes(raw.trim())) raw = await LocalModel.streamChat(messages, { temperature: 0.8, onDelta: () => {} });
        if (!raw.trim() && !intro) throw new Error("empty reply");
        reply = [intro, cleanReply(raw, !!intro)].filter(Boolean).join(" ");
      }
      shown = true;
      await agentStreamText(reply, handlers.onTextDelta);
      this._remember(userText, reply);
    } catch (err) {
      console.warn("On-device AI failed, using the built-in guide:", err);
      if (!shown) {
        await this.fallback.send(userText, handlers);
        return;
      }
      handlers.onTextDelta("\n\n(Something went wrong before I finished — please try again.)");
    }
    handlers.onDone();
  }

  async _route(userText) {
    const recent = this.history.slice(-2).map((m) => ({ role: m.role, content: clip(m.content) }));
    let choice;
    try {
      choice = await LocalModel.chooseJson(
        [{ role: "system", content: AGENT_ROUTER_PROMPT }, ...recent, { role: "user", content: clip(userText) }],
        RECLAIM_ROUTER_SCHEMA
      );
    } catch (err) {
      if (err instanceof SyntaxError) return null;
      throw err;
    }
    if (!choice) return null;
    if (choice.resource === "off_topic") return RECLAIM_ON_TOPIC.test(userText) ? null : { offTopic: true };
    if (!RECLAIM_TOOL_NAMES.has(choice.resource)) return null;
    const takesTheme = !!AGENT_TOOL_DEFS.find((t) => t.name === choice.resource).parameters.properties.theme;
    return { resource: choice.resource, theme: takesTheme && choice.theme !== "none" ? choice.theme : null };
  }

  _replyMessages(userText, intro) {
    let personal = "";
    try {
      personal = buildPersonalContext(CheckInStore.list());
    } catch (e) {}
    const context = [
      `Right now it is ${describeTimeOfDay(new Date())}.`,
      personal && `About this person, from their own check-ins: ${personal}`,
      intro && `The app has just said "${intro}" and shown it to them. Your reply comes right after that line, so continue naturally with one or two warm sentences and don't repeat it.`,
    ]
      .filter(Boolean)
      .join("\n");

    return [
      { role: "system", content: `${AGENT_SYSTEM_PROMPT}\n\n${context}` },
      ...this.history.slice(-RECLAIM_HISTORY_MESSAGES).map((m) => ({ role: m.role, content: clip(m.content) })),
      { role: "user", content: clip(userText) },
    ];
  }

  _remember(userText, reply) {
    this.history.push({ role: "user", content: userText }, { role: "assistant", content: reply });
    this.history = this.history.slice(-2 * RECLAIM_HISTORY_MESSAGES);
  }
}
