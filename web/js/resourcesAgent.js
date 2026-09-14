/**
 * ResourcesAgent simulates the Reclaim backend agent. It never gives therapy,
 * diagnoses, or clinical advice — its only job is to connect the user to real
 * scripture, people, and services, and to always point toward human help.
 *
 * Event contract (matches what a real streaming backend should emit):
 *   await agent.send(userText, {
 *     onCrisis: ({ lines }) => {},                 // urgent — show immediately, skip normal flow
 *     onToolCallStart: ({ id, name, input }) => {},
 *     onToolCallEnd: ({ id, output }) => {},
 *     onTextDelta: (chunk) => {},
 *     onDone: () => {},
 *   });
 *
 * All resource lookups go through ResourceRepo, which queries the local
 * SQLite database (db.js) — the same content and query layer the future
 * ML/pattern-recognition feature will read from.
 */
class ResourcesAgent {
  constructor() {
    this._idCounter = 0;
  }

  async send(userText, handlers) {
    if (this._isCrisis(userText)) {
      handlers.onCrisis({ lines: CRISIS_LINES });
      await wait(200);
      await this._streamText(
        "I'm really glad you told me. Please reach out to one of the numbers above right now, or call 911 if you're in immediate danger — a trained person can help in a way I can't. You don't have to go through this moment alone.",
        handlers.onTextDelta
      );
      handlers.onDone();
      return;
    }

    const plan = this._planResponse(userText);

    for (const step of plan.toolCalls) {
      const id = `tool_${++this._idCounter}`;
      handlers.onToolCallStart({ id, name: step.name, input: step.input });
      await wait(step.delay ?? 800);
      handlers.onToolCallEnd({ id, output: step.output });
    }

    await wait(200);
    await this._streamText(plan.reply, handlers.onTextDelta);
    handlers.onDone();
  }

  async _streamText(text, onTextDelta) {
    const words = text.split(/(\s+)/);
    for (const word of words) {
      onTextDelta(word);
      await wait(16 + Math.random() * 30);
    }
  }

  _isCrisis(text) {
    return CRISIS_PATTERNS.some((pattern) => pattern.test(text));
  }

  _planResponse(userText) {
    const lower = userText.toLowerCase();
    const theme = inferTheme(lower);

    if (/\b(verse|scripture|bible verse|passage|word of god)\b/.test(lower)) {
      const match = ResourceRepo.getScripture(theme);
      return {
        toolCalls: [{ name: "scripture_search", input: { theme }, output: match, delay: 700 }],
        reply: `${match.title} — "${match.body}" This isn't a quick fix, but it's worth sitting with. Would a sermon on this, a devotional, or a small group to process it with be helpful?`,
      };
    }

    if (/\b(bible plan|reading plan|devotional plan)\b/.test(lower)) {
      const plans = ResourceRepo.getBiblePlans();
      return {
        toolCalls: [{ name: "bible_plan_finder", input: { query: userText }, output: { plans }, delay: 850 }],
        reply: "Here are a couple of short reading plans. A few minutes a day, over a week or two, tends to land differently than a single passage read once.",
      };
    }

    if (/\b(devotional|daily reading|reflection)\b/.test(lower)) {
      const match = ResourceRepo.getDevotional(theme);
      return {
        toolCalls: [{ name: "devotional_finder", input: { theme }, output: match, delay: 700 }],
        reply: `"${match.title}" — ${match.body}`,
      };
    }

    if (/\b(article|read about|learn about|explain)\b/.test(lower)) {
      const articles = ResourceRepo.getArticles();
      return {
        toolCalls: [{ name: "article_finder", input: { query: userText }, output: { articles }, delay: 800 }],
        reply: "Here are a few articles that dig into this in more depth (sample content below).",
      };
    }

    if (/\b(coping|urge|craving|technique|what do i do right now|in the moment)\b/.test(lower)) {
      const mechanisms = ResourceRepo.getCopingMechanisms(theme);
      return {
        toolCalls: [{ name: "coping_toolkit", input: { theme }, output: { mechanisms }, delay: 650 }],
        reply: "Here are a few things that can help in the moment, while you also reach out to a real person. None of these replace an accountability partner or counselor — they're just for right now.",
      };
    }

    if (/\b(small group|church group|group near|community|men'?s group)\b/.test(lower)) {
      const groups = ResourceRepo.getSmallGroups();
      return {
        toolCalls: [{ name: "small_group_finder", input: { query: userText }, output: { groups }, delay: 900 }],
        reply: "Here are a few small groups (sample data below — swap in real local groups). Being physically or regularly present with other people is one of the biggest predictors of lasting recovery. Consider reaching out to one this week.",
      };
    }

    if (/\b(accountability|partner|someone to check|check on me)\b/.test(lower)) {
      const programs = ResourceRepo.getAccountabilityPrograms();
      return {
        toolCalls: [{ name: "accountability_match", input: { query: userText }, output: { programs }, delay: 850 }],
        reply: "Having someone who knows and regularly checks in with you changes the odds a lot. Here are a couple of ways to set that up — a real accountability partner isn't optional in recovery, it's one of the most protective things you can have.",
      };
    }

    if (/\b(sermon|message|talk|preach)\b/.test(lower)) {
      const sermons = ResourceRepo.getSermons();
      return {
        toolCalls: [{ name: "sermon_library", input: { query: userText }, output: { sermons }, delay: 800 }],
        reply: "A few sermons that speak directly to this (sample links below). Listening with someone else, or talking about it afterward with your small group, tends to land a lot deeper than listening alone.",
      };
    }

    if (/\b(counsel|counselor|counseling|therapist|therapy|professional help)\b/.test(lower)) {
      const centers = ResourceRepo.getCounselingCenters();
      return {
        toolCalls: [{ name: "counseling_directory", input: { query: userText }, output: { centers }, delay: 900 }],
        reply: "That's a really good instinct. A licensed counselor can help in ways I'm not able to — here are a few starting points (sample data, swap in real local or telehealth providers). It's worth calling even just to ask questions.",
      };
    }

    if (/\b(relapse|failed again|slipped|messed up|ashamed|shame|guilt|dirty|disgust)\b/.test(lower)) {
      const encouragement = pickRandom(ENCOURAGEMENTS);
      return {
        toolCalls: [{ name: "encouragement", input: { mood: "discouraged" }, output: { message: encouragement }, delay: 500 }],
        reply: `${encouragement} Would it help to see a scripture on this, a coping technique for right now, or find a small group?`,
      };
    }

    if (/^(hi|hey|hello)\b/.test(lower)) {
      return {
        toolCalls: [],
        reply: "Hey — I'm glad you're here. I can help you find scripture, a devotional, a bible plan, a sermon, an article, a coping technique, a local small group, an accountability partner, or a counseling center. I'm not a replacement for real people in your life, but I can help you find them. What would be most helpful right now?",
      };
    }

    return {
      toolCalls: [],
      reply: `You said: "${userText}". I'm best at connecting you with real things — scripture, a devotional, a sermon, an article, a coping technique, a small group, an accountability partner, or a counselor. Want me to look one of those up?`,
    };
  }
}

const CRISIS_PATTERNS = [
  /suicid/i,
  /kill (myself|me)\b/i,
  /end(ing)? (my|it all|it|this)\b/i,
  /don'?t want to (live|be alive|exist|wake up)/i,
  /want(ed)? to die/i,
  /wish(ed)? i (was|were) (dead|never born)/i,
  /wish i (wasn'?t|weren'?t) (here|alive|born)/i,
  /better off (dead|without me|gone)/i,
  /no (point|reason) (in|to) (living|life)/i,
  /can'?t go on/i,
  /not worth living/i,
  /hurt(ing)? myself/i,
  /self.?harm/i,
  /give up on (life|everything)/i,
  /no way out/i,
  /take my (own )?life/i,
  /ending my life/i,
];

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function inferTheme(lower) {
  const themes = [
    "shame", "temptation", "accountability", "identity", "freedom", "hope",
    "relapse", "struggle", "loneliness", "community", "grace", "growth",
    "perseverance", "triggers", "in-the-moment", "stress", "anxiety",
  ];
  return themes.find((t) => lower.includes(t)) || null;
}
