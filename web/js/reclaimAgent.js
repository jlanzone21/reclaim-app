// Reclaim's AI agent: a keyword match picks at most one resource card, the app introduces it, and the on-device model (LocalModel)
// writes a short reply that is streamed one checked sentence at a time.
const RECLAIM_HISTORY_CHARS = 5000; // ~1.3k tokens of the model's 4k context; past this the history is cut back to the last exchanges
const RECLAIM_HISTORY_KEEP = 4;
const RECLAIM_CLIP_CHARS = 400;
const RECLAIM_FALLBACK_REPLY =
  "I'm glad you reached out. You don't have to carry this alone. Is there someone you trust you could talk to today?";

const clip = (text, n = RECLAIM_CLIP_CHARS) => (text.length > n ? `${text.slice(0, n)}…` : text);

// The app, not the model, introduces each card: a small model asked to talk about specific resources misquotes or refuses them.
function cardIntro(name, theme, output) {
  if (name === "scripture_search" && output && output.todaysVerse) return "Here's today's verse from YouVersion.";
  const about = theme && theme !== "in-the-moment" ? ` about ${theme}` : "";
  return AGENT_TOOL_DEFS.find((t) => t.name === name).intro.replace("{about}", about);
}

// Small models invent verses, quotes, and contacts despite instructions, so any sentence containing one is dropped.
const RECLAIM_UNSAFE_SENTENCE = [
  /\b(?:[1-3]\s?)?[A-Z][a-z]+(?:\s(?:of\s)?[A-Z][a-z]+)?\s\d{1,3}:\d{1,3}/, // Bible reference, e.g. "1 John 4:16"
  /["“][^"”]{12,}["”]/, // quoted passage
  /\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/, // phone number
  /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|org|net|io|app)\b/i, // link or site
  // Tone failures, starting from a real one ("I hope you are feeling deeply overwhelmed by that shame"):
  /\bhope\b(?![^.!?]*(?:n't\b|\b(?:not|no longer|less|let go|release|lift|free|ease|relief|past|beyond|instead|rather than|without)\b))[^.!?]*\b(?:overwhelm\w*|ashamed|shame|guilt\w*|disgust\w*|worse|hopeless|terrible|awful|dirty|worthless|alone|pain)\b/i,
  /\byou(?: are|'re| must be| should be| deserve to be)\s+(?!not\b|never\b)(?:so |really |truly |just |completely |totally )?(?:disgusting|dirty|worthless|pathetic|a failure|hopeless|beyond help|unforgivable)\b/i,
  /\b(?:shame on you|you deserve (?:this|it|to suffer|to feel))\b/i,
  /\byou (?:don't|do not|won't) (?:really )?need (?:a |an |any |to (?:talk to|see) )?(?:pastor|counselor|therapist|small group|accountability|anyone|people|others)\b/i, // telling them real people aren't needed
  /\bof your own making\b|(?<!not )\bso broken\b|\byou(?:'re| are)\s+(?!not\b|never\b)broken\b/i, // blames them or labels them broken ("you're not broken" is fine)
  /\byou (?:have|might have|may have|probably have|are suffering from)\s+(?:a |an )?(?:\w+\s+)?(?:disorder|depression|ocd|adhd|ptsd|bipolar)\b/i, // diagnosis
  /\b(?:not a big deal|no big deal|everyone does it|just this once)\b|\b(?:porn|watching it|looking at it) is (?:fine|okay|ok|normal|healthy|harmless)\b/i, // downplaying
  /\bwould (?:today'?s|that|this|a|the) verse\b|\bverse (?:would )?(?:help|speak)\b|\bhelp(?:s)? you (?:feel|find)\b[^.!?]*\bverse\b/i, // offering a verse (the app shows them; the model must not)
  /\b(?:reach|call|text|contact|message) me\b|\bi(?:'m| am) always (?:here|available)\b/i, // the app standing in for real people
  /\bI (?:cannot|can't|can not|am unable to|am not able to) (?:share|provide|give(?! up)|offer|recommend|quote|find|show)\b/i, // refusing what the app just showed
  /^I(?:'m| am) (?:just |only |not )?an? (?:[\w-]+ )?(?:friend|assistant|program|model|companion|guide|counselor|therapist|pastor|christian|dictionary|bible|book|search engine)\b/i, // describing itself ("I am a Christian friend, not a Bible book")
];

const RECLAIM_SENTENCE_END = /^([\s\S]*?[.!?]+["'”’)]*)\s+/;

function isSafeSentence(sentence) {
  return !RECLAIM_UNSAFE_SENTENCE.some((re) => re.test(sentence));
}

// Reveals text word by word without holding up generation; `done()` resolves once everything queued has been shown.
function createRevealer(onTextDelta) {
  let chain = Promise.resolve();
  let first = true;
  return {
    push(text) {
      const piece = first ? text : ` ${text}`;
      first = false;
      chain = chain.then(() => agentStreamText(piece, onTextDelta));
    },
    done: () => chain,
  };
}

class ReclaimAgent {
  constructor() {
    // Exactly what the model was sent and wrote, unfiltered. WebLLM only reuses its cache when a request repeats the
    // previous conversation word for word, so this must never be edited or re-clipped between turns.
    this.modelHistory = [];
    this.recentShown = []; // last few replies as shown; small models copy their own earlier sentences word for word
    this.fallback = new ResourcesAgent();
    this._idCounter = 0;
  }

  async send(userText, handlers) {
    // Crisis detection must run before the model is involved and never depend on it.
    if (agentIsCrisis(userText)) {
      handlers.onCrisis({ lines: CRISIS_LINES });
      await agentStreamText(CRISIS_REPLY, handlers.onTextDelta);
      this._remember(clip(userText), CRISIS_REPLY, CRISIS_REPLY);
      handlers.onDone();
      return;
    }

    if (!LocalModel.isReady()) {
      await this.fallback.send(userText, handlers);
      return;
    }

    const revealer = createRevealer(handlers.onTextDelta);
    const previous = this.recentShown[this.recentShown.length - 1] || "";
    const kept = [];
    let shown = false;
    try {
      let intro = "";
      const pick = agentPickResource(userText, previous);
      if (pick) {
        const input = pick.theme ? { theme: pick.theme } : { query: userText };
        const output = await executeAgentTool(pick.resource, input);
        if (output && output.groups === null) {
          // Supabase unreachable (small_group_finder only) -- say so instead of showing an empty card.
          intro = "I couldn't reach the group directory right now — try again once you're online.";
          revealer.push(intro);
        } else {
          const id = `tool_${++this._idCounter}`;
          handlers.onToolCallStart({ id, name: pick.resource, input });
          handlers.onToolCallEnd({ id, output });
          intro = cardIntro(pick.resource, pick.theme, output);
          revealer.push(intro);
        }
        // The app's one-sentence intro ("I found some Bible reading plans you could start.") is the whole reply when
        // resources are shown. The model used to add more, and its extra sentences were where the unreliable advice, theology,
        // invented resources and stray verse offers came from (see llm-prompt-tests). It also saves a model call.
        await revealer.done();
        this.recentShown = [...this.recentShown, intro].slice(-3);
        handlers.onDone();
        return;
      }
      const maxSentences = 2;

      const accept = (sentence) => {
        const s = sentence.trim();
        if (!s || !isSafeSentence(s) || this.recentShown.some((r) => r.includes(s))) return;
        kept.push(s);
        revealer.push(s);
        shown = true;
      };

      // Per-turn instructions go in the user message, not the system prompt, so the system prompt stays identical across turns.
      const userContent = clip(userText);

      let pending = "";
      const { raw, finishReason } = await LocalModel.streamChat(this._replyMessages(userContent), {
        onDelta: (delta) => {
          pending += delta;
          let m;
          while (kept.length < maxSentences && (m = pending.match(RECLAIM_SENTENCE_END))) {
            pending = pending.slice(m[0].length);
            accept(m[1]);
          }
          return kept.length < maxSentences;
        },
      });
      // A last sentence without trailing space is complete only if the model stopped on its own, not at the token limit.
      if (finishReason === "stop" && kept.length < maxSentences) accept(pending);

      if (!kept.length && !intro) revealer.push(RECLAIM_FALLBACK_REPLY);
      shown = true;
      await revealer.done();
      this._remember(userContent, raw, [intro, ...kept].join(" ") || RECLAIM_FALLBACK_REPLY);
    } catch (err) {
      console.warn("On-device AI failed, using the built-in guide:", err);
      await revealer.done();
      if (!shown) {
        await this.fallback.send(userText, handlers);
        return;
      }
      handlers.onTextDelta("\n\n(Something went wrong before I finished — please try again.)");
    }
    handlers.onDone();
  }

  _replyMessages(userContent) {
    let personal = "";
    try {
      personal = buildPersonalContext(CheckInStore.list());
    } catch (e) {}
    let preferences = "";
    try {
      preferences = buildUserPreferencesContext(UserPreferencesStore.get());
    } catch (e) {}
    const context = [
      `Right now it is ${describeTimeOfDay(new Date())}.`,
      personal && `About this person, from their own check-ins: ${personal}`,
      preferences && `What they told us when setting up the app: ${preferences}`,
    ]
      .filter(Boolean)
      .join("\n");

    return [
      { role: "system", content: `${AGENT_SYSTEM_PROMPT}\n\n${context}` },
      ...this.modelHistory,
      { role: "user", content: userContent },
    ];
  }

  _remember(userContent, modelReply, shownReply) {
    this.recentShown = [...this.recentShown, shownReply].slice(-3);
    this.modelHistory.push({ role: "user", content: userContent }, { role: "assistant", content: modelReply });
    // Trimming changes the conversation, so the next turn re-reads it once; that's why it's done rarely, not every turn.
    const size = this.modelHistory.reduce((n, m) => n + m.content.length, 0);
    if (size > RECLAIM_HISTORY_CHARS) this.modelHistory = this.modelHistory.slice(-RECLAIM_HISTORY_KEEP);
  }
}
