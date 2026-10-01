/**
 * ResourcesAgent is the scripted guide ReclaimAgent falls back to when the AI server can't answer. It never gives therapy,
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
      await this._streamText(CRISIS_REPLY, handlers.onTextDelta);
      handlers.onDone();
      return;
    }

    const fixed = typeof FixedAnswers !== "undefined" ? FixedAnswers.match(userText) : null;
    if (fixed) {
      await wait(200);
      await this._streamText(fixed.reply, handlers.onTextDelta);
      handlers.onDone();
      return;
    }

    const plan = await this._planResponse(userText);

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

  // Basic mode's own regex-based intent matching (deliberately broader than agentTools.js's
  // AGENT_TOOL_DEFS patterns, tuned for a scripted fallback with no model to lean on) decides
  // WHICH tool to call, but every tool's actual data now comes from the single shared
  // executeAgentTool (agentTools.js) -- the same function ReclaimAgent uses. This used to be a
  // hand-duplicated copy of each ResourceRepo call, which is exactly how the two modes drifted:
  // a fix to one (e.g. accountability_match becoming personal-contact-aware) never reached the
  // other. One source of truth for what a tool actually returns, from here on.
  async _planResponse(userText) {
    const lower = userText.toLowerCase();
    const theme = inferTheme(lower);

    if (/\b(verse|scripture|bible verse|passage|word of god)\b/.test(lower)) {
      const match = await executeAgentTool("scripture_search", { theme });
      return {
        toolCalls: [{ name: "scripture_search", input: { theme }, output: match, delay: 700 }],
        // With the YouVersion display the card already shows the verse (and its required
        // attribution), so the reply points to it instead of quoting a second copy.
        reply: match.youversion
          ? `${match.todaysVerse ? "That's today's verse" : "Here's a verse"} from YouVersion — ${match.title}. This isn't a quick fix, but it's worth sitting with. Would a sermon on this, a devotional, or a small group to process it with be helpful?`
          : `${match.title} — "${match.body}" This isn't a quick fix, but it's worth sitting with. Would a sermon on this, a devotional, or a small group to process it with be helpful?`,
      };
    }

    if (/\b(bible plan|reading plan|devotional plan)\b/.test(lower)) {
      const output = await executeAgentTool("bible_plan_finder", {});
      return {
        toolCalls: [{ name: "bible_plan_finder", input: { query: userText }, output, delay: 850 }],
        reply: "Here are a couple of short reading plans. A few minutes a day, over a week or two, tends to land differently than a single passage read once.",
      };
    }

    if (/\b(devotional|daily reading|reflection)\b/.test(lower)) {
      const match = await executeAgentTool("devotional_finder", { theme });
      return {
        toolCalls: [{ name: "devotional_finder", input: { theme }, output: match, delay: 700 }],
        reply: `"${match.title}" — ${match.body}`,
      };
    }

    if (/\b(article|read about|learn about|explain)\b/.test(lower)) {
      const output = await executeAgentTool("article_finder", {});
      if (output.articles === null) {
        return { toolCalls: [], reply: "I couldn't reach the article library right now — try again once you're online." };
      }
      return {
        toolCalls: [{ name: "article_finder", input: { query: userText }, output, delay: 800 }],
        reply: "Here are a few articles that dig into this in more depth.",
      };
    }

    if (/\b(coping|urges?|cravings?|tempt\w*|about to|technique|what do i do right now|in the moment)\b/.test(lower)) {
      const output = await executeAgentTool("coping_toolkit", { theme });
      return {
        toolCalls: [{ name: "coping_toolkit", input: { theme }, output, delay: 650 }],
        reply: "Here are a few things that can help in the moment, while you also reach out to a real person. None of these replace an accountability partner or counselor — they're just for right now.",
      };
    }

    if (/\bgroups?\b|\bcommunity\b/.test(lower)) {
      const output = await executeAgentTool("small_group_finder", { query: userText });
      if (output.groups === null) {
        return { toolCalls: [], reply: "I couldn't reach the group directory right now — try again once you're online." };
      }
      return {
        toolCalls: [{ name: "small_group_finder", input: { query: userText }, output, delay: 900 }],
        reply: "Here are a few real recovery groups. Being physically or regularly present with other people is one of the biggest predictors of lasting recovery — consider reaching out to one this week.",
      };
    }

    if (/\b(accountability|partner|someone to check|check on me)\b/.test(lower)) {
      const output = await executeAgentTool("accountability_match", {});
      const reply = output.contacts && output.contacts.length
        ? `Have you talked to ${output.contacts.map((c) => c.name).join(" or ")} about this? That's exactly what they're there for.`
        : "Having someone who knows and regularly checks in with you changes the odds a lot. Add your accountability partner in Privacy so Reclaim can bring up their contact right when you need it.";
      return {
        toolCalls: [{ name: "accountability_match", input: { query: userText }, output, delay: 850 }],
        reply,
      };
    }

    if (/\b(sermon|message|talk|preach)\b/.test(lower)) {
      const output = await executeAgentTool("sermon_library", {});
      if (output.sermons === null) {
        return { toolCalls: [], reply: "I couldn't reach the sermon library right now — try again once you're online." };
      }
      return {
        toolCalls: [{ name: "sermon_library", input: { query: userText }, output, delay: 800 }],
        reply: "A few sermons that speak directly to this. Listening with someone else, or talking about it afterward with your small group, tends to land a lot deeper than listening alone.",
      };
    }

    if (/\b(counsel|counselor|counseling|therapist|therapy|professional help)\b/.test(lower)) {
      const output = await executeAgentTool("counseling_directory", {});
      if (output.centers === null) {
        return { toolCalls: [], reply: "I couldn't reach the counseling directory right now — try again once you're online." };
      }
      return {
        toolCalls: [{ name: "counseling_directory", input: { query: userText }, output, delay: 900 }],
        reply: "That's a really good instinct. A licensed counselor can help in ways I'm not able to — here are a few starting points. It's worth calling even just to ask questions.",
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

    // Nothing above matched, but agentInferTheme (agentTools.js -- a broader, colloquial-phrasing
    // word list than this file's own inferTheme just above) catches a named feeling that theme's
    // literal name substring-match wouldn't (e.g. "I feel lonely" vs. requiring "loneliness").
    // Same reasoning as ReclaimAgent's own fallback: default to a verse rather than staying
    // generic when someone's named how they feel, even in Basic mode.
    const broaderTheme = agentInferTheme(lower);
    if (broaderTheme) {
      const match = await executeAgentTool("scripture_search", { theme: broaderTheme });
      return {
        toolCalls: [{ name: "scripture_search", input: { theme: broaderTheme }, output: match, delay: 700 }],
        reply: match.youversion
          ? `Here's a verse from YouVersion for that — ${match.title}. Would a coping technique, a devotional, or a small group to process this with also help?`
          : `${match.title} — "${match.body}" Would a coping technique, a devotional, or a small group to process this with also help?`,
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
  /\bend(ing)? (my|it all|it|this)\b/i,
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
  /\boverdos(e|ed|ing)\b/i,
  /\b(took|taken|swallowed) (too many|a bunch of|a lot of|all (of )?my) (pills|tablets|meds|medication)\b/i,
  /\b(cut|cutting) myself\b(?! (?:off|some|loose|slack|a\b|shaving|cooking|chopping|slicing|on\b|with\b|by accident))/i, // not "cut myself off from..." / "cut myself shaving"
  /\bjump(ing)? off (a|the|my) (bridge|building|roof|balcony|cliff|overpass)\b/i,
  /\b(no ?one|nobody) (would|will) (even )?(miss|care|notice) (me|if i)\b/i,
  /\b(i'?m|i am|am) (just )?a burden to (everyone|everybody|my (family|wife|husband|kids|friends)|others)\b/i,
  /\b(tired|sick) of (being alive|living)\b(?! (?:in|with|like|a|the|my|this|under|out|off)\b)/i, // not "sick of living in secret / like this" (about the addiction)
  /\bdone with (life|living)\b/i,
  /\blife (isn'?t|is not|ain'?t) worth (living|it)\b/i,
  /\bnothing (left )?to live for\b/i,
  /\bwant (it all|everything) to end\b/i,
  /\bkilling myself\b/i, // "kill myself" was covered but not "killing myself" ("killing me" stays out: it is an idiom)
  /\b(easiest|quickest|painless|best) way to (die(?! (?:my|your|his|her|their|the|a)\b)|kill myself|end (it|my life))\b/i, // not "way to die (dye) your hair"
  /\bno reason to live\b|\b(no|any|don'?t see (a|any)) reason to (keep living|go on)\b/i,
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
