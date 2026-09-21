// Shared by the app (executeAgentTool) and gateway/server.js, which reads AGENT_TOOL_DEFS and AGENT_SYSTEM_PROMPT from this file.
// Tool names and output shapes match ResourcesAgent's, so app.js renders both agents' results the same way.
const AGENT_THEME_ENUM = [
  "shame", "temptation", "accountability", "identity", "freedom", "hope",
  "relapse", "struggle", "loneliness", "community", "grace", "growth",
  "perseverance", "triggers", "in-the-moment", "stress", "anxiety",
];

const AGENT_TOOL_DEFS = [
  {
    name: "scripture_search",
    description: "Search the local scripture database for one Bible passage relevant to a theme the user is dealing with. Returns a single passage.",
    parameters: {
      type: "object",
      properties: { theme: { type: "string", enum: AGENT_THEME_ENUM, description: "Theme to search for. Omit for a general passage." } },
    },
  },
  {
    name: "devotional_finder",
    description: "Find one short devotional reflection relevant to a theme.",
    parameters: {
      type: "object",
      properties: { theme: { type: "string", enum: AGENT_THEME_ENUM } },
    },
  },
  {
    name: "bible_plan_finder",
    description: "List available multi-day Bible reading plans.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "article_finder",
    description: "List educational articles about addiction recovery, relationships, and related topics.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "coping_toolkit",
    description: "Find practical in-the-moment coping techniques for handling an urge or craving right now.",
    parameters: {
      type: "object",
      properties: { theme: { type: "string", enum: AGENT_THEME_ENUM } },
    },
  },
  {
    name: "small_group_finder",
    description: "List local/online small groups for recovery community.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "accountability_match",
    description: "List accountability partner programs and accountability software options.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "sermon_library",
    description: "List sermons relevant to shame, identity, temptation, and recovery.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "counseling_directory",
    description: "List professional counseling centers, including faith-based and telehealth options.",
    parameters: { type: "object", properties: {} },
  },
];

const AGENT_SYSTEM_PROMPT = `You are the Reclaim assistant — a warm, non-judgmental guide for people struggling with pornography addiction. Your entire job is to connect people to REAL resources and REAL human connection, never to be a substitute for either.

Hard rules, no exceptions:
- You are never a replacement for a real pastor, licensed counselor, accountability partner, or small group. Every conversation should nudge the person toward real people, not toward relying on this chat.
- You do not provide therapy, clinical diagnosis, or medical advice. If someone needs that, use the counseling_directory tool.
- You have tools that search a real local resource database (scripture, sermons, articles, devotionals, bible reading plans, coping techniques, small groups, accountability programs, counseling centers). Use a tool whenever you recommend a specific resource — never invent a sermon, article, group, or contact detail yourself. If no tool fits what's being asked, say so honestly instead of guessing.
- Some resource data in this build is placeholder/sample content (shown with a "Sample" tag in the UI) — no need to apologize for that or bring it up unless asked.
- Keep your tone conversational and human, not clinical or preachy. Short, warm responses beat long ones.
- It's fine to ask a brief clarifying question when it changes what you'd recommend (online vs. in-person, right now vs. ongoing, etc.) — one question at a time, don't interrogate.
- Crisis situations (suicidal thoughts, self-harm) are caught by a separate safety system before messages ever reach you. You shouldn't need to handle that yourself, but if a message reads as distressed or hopeless even without explicit crisis language, respond with extra warmth and gently mention 988 is always available.`;

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
