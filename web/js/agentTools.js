// Resource tools, prompts, and the crisis check shared by ReclaimAgent (on-device AI) and ResourcesAgent (Basic mode).
// Tool names and output shapes match ResourcesAgent's, so app.js renders both agents' results the same way.
const AGENT_THEME_ENUM = [
  "shame", "temptation", "accountability", "identity", "freedom", "hope",
  "relapse", "struggle", "loneliness", "community", "grace", "growth",
  "perseverance", "triggers", "in-the-moment", "stress", "anxiety",
];

const AGENT_TOOL_DEFS = [
  {
    name: "scripture_search",
    summary: "a Bible verse",
    intro: "I found a verse{about} for you.",
    description: "Search the local scripture database for one Bible passage relevant to a theme the user is dealing with. Returns a single passage.",
    parameters: {
      type: "object",
      properties: { theme: { type: "string", enum: AGENT_THEME_ENUM, description: "Theme to search for. Omit for a general passage." } },
    },
  },
  {
    name: "devotional_finder",
    summary: "a short devotional reflection",
    intro: "I found a short devotional{about} for you.",
    description: "Find one short devotional reflection relevant to a theme.",
    parameters: {
      type: "object",
      properties: { theme: { type: "string", enum: AGENT_THEME_ENUM } },
    },
  },
  {
    name: "bible_plan_finder",
    summary: "multi-day Bible reading plans",
    intro: "I found some Bible reading plans you could start.",
    description: "List available multi-day Bible reading plans.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "article_finder",
    summary: "articles about addiction, recovery, and relationships",
    intro: "I found some articles that might help.",
    description: "List educational articles about addiction recovery, relationships, and related topics.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "coping_toolkit",
    summary: "practical ways to get through an urge or temptation right now",
    intro: "I found a few ideas that can help in hard moments.",
    description: "Find practical in-the-moment coping techniques for handling an urge or craving right now.",
    parameters: {
      type: "object",
      properties: { theme: { type: "string", enum: AGENT_THEME_ENUM } },
    },
  },
  {
    name: "small_group_finder",
    summary: "recovery small groups and community",
    intro: "I found some recovery groups you could look into.",
    description: "List local/online small groups for recovery community.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "accountability_match",
    summary: "accountability partners, programs, and software",
    intro: "I found some accountability options for you.",
    description: "List accountability partner programs and accountability software options.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "sermon_library",
    summary: "sermons",
    intro: "I found some sermons you might find helpful.",
    description: "List sermons relevant to shame, identity, temptation, and recovery.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "counseling_directory",
    summary: "professional counselors and therapists",
    intro: "I found some counselors you could reach out to.",
    description: "List professional counseling centers, including faith-based and telehealth options.",
    parameters: { type: "object", properties: {} },
  },
];

const AGENT_SYSTEM_PROMPT = `You are the Reclaim assistant, a warm, non-judgmental friend for someone working to overcome pornography addiction. You never replace a pastor, counselor, accountability partner, or small group, and you gently encourage those connections.

How to reply:
- 1 to 3 short sentences of plain text. No lists, no Markdown, no links.
- Talk about them and how they are feeling, like a caring friend. Ask at most one gentle question.
- The app shows verses, devotionals, groups, counselors, and other resources itself. Never quote, name, list, or recommend any yourself, and never say you can't provide them.
- Never give therapy, diagnosis, or medical advice.
- If you are told something about this person from their check-ins, you may gently acknowledge it when it is relevant. Never recite details or make them feel watched.
- If they sound hopeless, respond with extra warmth and remind them that the 988 Suicide and Crisis Lifeline is free and open by call or text anytime.`;

const AGENT_ROUTER_PROMPT = `You decide which resource the Reclaim app should show next, for someone working to overcome pornography addiction. Options:
${AGENT_TOOL_DEFS.map((t) => `${t.name}: ${t.summary}`).join("\n")}
off_topic: a request clearly unrelated to their life, feelings, faith, or recovery, like trivia, homework, or coding
none: show nothing

Choose a resource only when they ask for one, say yes to one that was just offered, or are facing an urge right now. Sharing a feeling or a slip, saying yes to talking, or greeting you is not a request: choose none. Feelings like loneliness, stress, sadness, anger, boredom, or shame are always on topic, never off_topic. For theme, pick the closest match, or "none".

Examples:
"Give me a verse about hope" -> scripture_search, hope
"I'm about to look at porn right now, help" -> coping_toolkit, in-the-moment
"Are there any groups near me?" -> small_group_finder, none
"I slipped again last night" -> none, none
"I just slipped again and feel awful" -> none, none
"I feel really lonely tonight" -> none, none
"Work has been so stressful" -> none, none
"I feel so ashamed" -> none, none
"Yes, I'd like to talk about it" -> none, none
"Yes please" right after being offered a devotional -> devotional_finder, none
"hi" -> none, none
"What's the capital of Spain?" -> off_topic, none
"Write me a poem about cats" -> off_topic, none`;

function executeAgentTool(name, input) {
  const theme = input && input.theme ? input.theme : null;
  switch (name) {
    case "scripture_search":
      return ResourceRepo.getScripture(theme);
    case "devotional_finder":
      return ResourceRepo.getDevotional(theme);
    case "bible_plan_finder":
      return { plans: ResourceRepo.getBiblePlans() };
    case "article_finder":
      return { articles: ResourceRepo.getArticles() };
    case "coping_toolkit":
      return { mechanisms: ResourceRepo.getCopingMechanisms(theme) };
    case "small_group_finder":
      return { groups: ResourceRepo.getSmallGroups() };
    case "accountability_match":
      return { programs: ResourceRepo.getAccountabilityPrograms() };
    case "sermon_library":
      return { sermons: ResourceRepo.getSermons() };
    case "counseling_directory":
      return { centers: ResourceRepo.getCounselingCenters() };
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
