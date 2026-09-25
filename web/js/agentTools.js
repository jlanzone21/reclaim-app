// Resource tools, prompts, and the crisis check shared by ReclaimAgent (on-device AI) and ResourcesAgent (Basic mode).
// Tool names and output shapes match ResourcesAgent's, so app.js renders both agents' results the same way.

// `pattern` picks the card by keyword instead of asking the model, which cost ~16 s per message on a phone.
// Checked in order, first match wins. Only an explicit ask or an urge happening now shows a card:
// someone sharing a slip or a feeling gets a reply, not a resource they didn't ask for.
const AGENT_TOOL_DEFS = [
  {
    name: "bible_plan_finder",
    intro: "I found some Bible reading plans you could start.",
    pattern: /\b(bible|reading|devotional) plans?\b/,
  },
  {
    name: "scripture_search",
    intro: "I found a verse{about} for you.",
    pattern: /\b(verses?|scriptures?|passages?|psalms?)\b/,
    themed: true,
  },
  {
    name: "devotional_finder",
    intro: "I found a short devotional{about} for you.",
    pattern: /\bdevotionals?\b/,
    themed: true,
  },
  {
    name: "sermon_library",
    intro: "I found some sermons you might find helpful.",
    pattern: /\b(sermons?|preach\w*)\b/,
  },
  {
    name: "article_finder",
    intro: "I found some articles that might help.",
    pattern: /\b(articles?|something to read|read (more )?about)\b/,
  },
  {
    name: "counseling_directory",
    intro: "I found some counselors you could reach out to.",
    pattern: /\b(counsel\w*|therap\w*|professional help)\b/,
  },
  {
    name: "small_group_finder",
    intro: "I found some recovery groups you could look into.",
    pattern: /\bgroups?\b|\bcommunity\b/,
  },
  {
    name: "accountability_match",
    intro: "Let's look at your accountability partner.",
    pattern: /\baccountab\w*/,
  },
  {
    name: "coping_toolkit",
    intro: "Here are a few things that can help right now.",
    pattern: /\b(urges?|crav\w*|tempt\w*|coping|in the moment|about to (look|watch|give in|relapse|slip|act out)|want to (look|watch))\b/,
    themed: true,
  },
];

// Keyword → theme, checked in order. Themes are the tags used in seedData.js.
const AGENT_THEME_WORDS = [
  ["shame", /\b(shame\w*|ashamed|guilt\w*|disgust\w*|dirty|worthless)\b/],
  ["temptation", /\btempt\w*/],
  ["loneliness", /\b(lonel\w*|alone|isolat\w*)\b/],
  ["anxiety", /\b(anxi\w*|worr\w*|panic\w*|afraid|scared)\b/],
  ["stress", /\b(stress\w*|overwhelm\w*|pressure)\b/],
  ["hope", /\b(hope\w*|despair\w*)\b/],
  ["relapse", /\b(relaps\w*|slip\w*|fail\w*)\b/],
  ["grace", /\b(grace|forgiv\w*|mercy)\b/],
  ["identity", /\b(identity|who i am)\b/],
  ["freedom", /\bfree(dom)?\b/],
  ["perseverance", /\b(persever\w*|keep going|give up|endur\w*)\b/],
  ["accountability", /\baccountab\w*/],
  ["community", /\b(community|church|friends?)\b/],
  ["triggers", /\btrigger\w*/],
  ["growth", /\bgrow\w*/],
  ["struggle", /\bstruggl\w*/],
];

const AGENT_AFFIRMATIVE = /^\s*(yes|yeah|yep|yup|sure|ok(ay)?|please|that would help|i'?d like that)\b/i;

function agentInferTheme(lower) {
  const hit = AGENT_THEME_WORDS.find(([, re]) => re.test(lower));
  return hit ? hit[0] : null;
}

// A short "yes" answers whatever the last reply offered ("Would a verse on grace help?"), so it's matched against that reply instead.
function agentPickResource(userText, lastReply = "") {
  let lower = userText.toLowerCase();
  if (AGENT_AFFIRMATIVE.test(userText) && userText.length < 40 && lastReply) lower = lastReply.toLowerCase();
  const tool = AGENT_TOOL_DEFS.find((t) => t.pattern.test(lower));
  if (!tool) return null;
  const theme = tool.themed ? agentInferTheme(lower) || (tool.name === "coping_toolkit" ? "in-the-moment" : null) : null;
  return { resource: tool.name, theme };
}

const AGENT_SYSTEM_PROMPT = `You are Reclaim. You talk with someone fighting pornography addiction like a warm, caring friend, from a Christian perspective. You never replace real people like a pastor, counselor, accountability partner, or small group.

Reply in 1 to 3 short plain sentences, like a caring friend, with at most one gentle question.
- Never let them dwell in shame. Name it gently, then point to God's grace and forgiveness, and encourage them to bring their shame to God in prayer.
- Encourage real human contact: confessing to a trusted friend, especially if they've kept it hidden, or reaching out to their accountability partner, pastor, or group today. If their setup answers name an accountability partner or pastor, encourage reaching out to that person by name (e.g. "have you talked to Joey about this?") instead of the generic phrase — that's the whole reason they told you. Pick what fits the moment; don't lecture.
- The app shows verses, groups, counselors, and other resources. You may offer one kind, like "a verse" or "coping ideas", but never quote, name, or list any, and never say you can't provide them.
- No therapy, diagnosis, or medical advice.
- You may gently use what you're told about their check-ins and setup answers (accountability partner/pastor by name, when or where they're usually tempted). Never recite it back as a list — weave it in naturally, like a friend who remembers, not a report.
- If they sound hopeless, mention the 988 Lifeline is free by call or text, anytime.
- If a message has nothing to do with their life, faith, or recovery, don't answer it. Kindly say you're only here for those.`;

// async because small_group_finder/sermon_library/article_finder/counseling_directory all read
// live from Supabase now (see ResourceRepo) -- every other branch below still resolves
// synchronously, `await`ing a non-promise is a no-op.
async function executeAgentTool(name, input) {
  const theme = input && input.theme ? input.theme : null;
  switch (name) {
    case "scripture_search":
      return ResourceRepo.getScripture(theme);
    case "devotional_finder":
      return ResourceRepo.getDevotional(theme);
    case "bible_plan_finder":
      return { plans: ResourceRepo.getBiblePlans() };
    case "article_finder":
      return { articles: await ResourceRepo.getArticles() };
    case "coping_toolkit":
      return { mechanisms: ResourceRepo.getCopingMechanisms(theme) };
    case "small_group_finder":
      return { groups: await ResourceRepo.getSmallGroups(input && input.query) };
    case "accountability_match": {
      // Deterministic, not model-dependent: this is real personal data (or the deliberate
      // absence of it), never a generic sample list -- see PURPOSE.md.
      const prefs = UserPreferencesStore.get();
      return prefs.accountability_name && prefs.accountability_phone
        ? { hasContact: true, name: prefs.accountability_name, phone: prefs.accountability_phone }
        : { hasContact: false };
    }
    case "sermon_library":
      return { sermons: await ResourceRepo.getSermons() };
    case "counseling_directory":
      return { centers: await ResourceRepo.getCounselingCenters() };
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

function agentStreamText(text, onTextDelta) {
  return (async () => {
    const words = text.split(/(\s+)/);
    for (const word of words) {
      onTextDelta(word);
      await new Promise((r) => setTimeout(r, 16 + Math.random() * 30));
    }
  })();
}

function agentIsCrisis(text) {
  return CRISIS_PATTERNS.some((pattern) => pattern.test(text));
}
