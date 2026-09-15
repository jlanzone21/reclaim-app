/**
 * ClaudeAgent — the real (non-mocked) Reclaim agent. Talks to the Claude API
 * directly from this device using the user's own API key (see
 * settingsStore.js), with tool-calling against the local SQLite resource
 * database (resourceRepo.js) so every recommendation is grounded in real
 * data rather than invented by the model.
 *
 * Implements the exact same event contract as ResourcesAgent (see
 * resourcesAgent.js) so app.js doesn't need to know which one it's talking
 * to:
 *   await agent.send(userText, {
 *     onCrisis: ({ lines }) => {},
 *     onToolCallStart: ({ id, name, input }) => {},
 *     onToolCallEnd: ({ id, output }) => {},
 *     onTextDelta: (chunk) => {},
 *     onDone: () => {},
 *   });
 *
 * Crisis detection runs BEFORE any API call, using the same CRISIS_PATTERNS
 * regex safety net as ResourcesAgent — this must never depend on model
 * judgment alone.
 */
const THEME_ENUM = [
  "shame", "temptation", "accountability", "identity", "freedom", "hope",
  "relapse", "struggle", "loneliness", "community", "grace", "growth",
  "perseverance", "triggers", "in-the-moment", "stress", "anxiety",
];

const CLAUDE_TOOLS = [
  {
    name: "scripture_search",
    description: "Search the local scripture database for one Bible passage relevant to a theme the user is dealing with. Returns a single passage.",
    input_schema: {
      type: "object",
      properties: { theme: { type: "string", enum: THEME_ENUM, description: "Theme to search for. Omit for a general passage." } },
    },
  },
  {
    name: "devotional_finder",
    description: "Find one short devotional reflection relevant to a theme.",
    input_schema: {
      type: "object",
      properties: { theme: { type: "string", enum: THEME_ENUM } },
    },
  },
  {
    name: "bible_plan_finder",
    description: "List available multi-day Bible reading plans.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "article_finder",
    description: "List educational articles about addiction recovery, relationships, and related topics.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "coping_toolkit",
    description: "Find practical in-the-moment coping techniques for handling an urge or craving right now.",
    input_schema: {
      type: "object",
      properties: { theme: { type: "string", enum: THEME_ENUM } },
    },
  },
  {
    name: "small_group_finder",
    description: "List local/online small groups for recovery community.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "accountability_match",
    description: "List accountability partner programs and accountability software options.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "sermon_library",
    description: "List sermons relevant to shame, identity, temptation, and recovery.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "counseling_directory",
    description: "List professional counseling centers, including faith-based and telehealth options.",
    input_schema: { type: "object", properties: {} },
  },
];

const CLAUDE_SYSTEM_PROMPT = `You are the Reclaim assistant — a warm, non-judgmental guide for people struggling with pornography addiction. Your entire job is to connect people to REAL resources and REAL human connection, never to be a substitute for either.

Hard rules, no exceptions:
- You are never a replacement for a real pastor, licensed counselor, accountability partner, or small group. Every conversation should nudge the person toward real people, not toward relying on this chat.
- You do not provide therapy, clinical diagnosis, or medical advice. If someone needs that, use the counseling_directory tool.
- You have tools that search a real local resource database (scripture, sermons, articles, devotionals, bible reading plans, coping techniques, small groups, accountability programs, counseling centers). Use a tool whenever you recommend a specific resource — never invent a sermon, article, group, or contact detail yourself. If no tool fits what's being asked, say so honestly instead of guessing.
- Some resource data in this build is placeholder/sample content (shown with a "Sample" tag in the UI) — no need to apologize for that or bring it up unless asked.
- Keep your tone conversational and human, not clinical or preachy. Short, warm responses beat long ones.
- It's fine to ask a brief clarifying question when it changes what you'd recommend (online vs. in-person, right now vs. ongoing, etc.) — one question at a time, don't interrogate.
- Crisis situations (suicidal thoughts, self-harm) are caught by a separate safety system before messages ever reach you. You shouldn't need to handle that yourself, but if a message reads as distressed or hopeless even without explicit crisis language, respond with extra warmth and gently mention 988 is always available.`;

class ClaudeAgent {
  constructor(apiKey, model) {
    this.client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    this.model = model || SettingsStore.DEFAULT_MODEL;
    this.history = [];
    this._idCounter = 0;
  }

  async send(userText, handlers) {
    if (this._isCrisis(userText)) {
      handlers.onCrisis({ lines: CRISIS_LINES });
      this.history.push({ role: "user", content: userText });
      const reply =
        "I'm really glad you told me. Please reach out to one of the numbers above right now, or call 911 if you're in immediate danger — a trained person can help in a way I can't. You don't have to go through this moment alone.";
      await this._streamText(reply, handlers.onTextDelta);
      this.history.push({ role: "assistant", content: reply });
      handlers.onDone();
      return;
    }

    this.history.push({ role: "user", content: userText });

    try {
      let guard = 0;
      while (guard++ < 6) {
        const status = await this._runTurn(handlers);
        if (status === "done") break;
      }
    } catch (err) {
      this._handleError(err, handlers);
    }
    handlers.onDone();
  }

  async _runTurn(handlers) {
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 4096,
      thinking: { type: "disabled" },
      system: CLAUDE_SYSTEM_PROMPT,
      tools: CLAUDE_TOOLS,
      messages: this.history,
    });

    const pendingBlocks = {};
    const toolResults = [];

    for await (const event of stream) {
      if (event.type === "content_block_start") {
        pendingBlocks[event.index] = { type: event.content_block.type };
        if (event.content_block.type === "tool_use") {
          pendingBlocks[event.index].id = event.content_block.id;
          pendingBlocks[event.index].name = event.content_block.name;
          pendingBlocks[event.index].jsonBuf = "";
        }
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          handlers.onTextDelta(event.delta.text);
        } else if (event.delta.type === "input_json_delta") {
          const blk = pendingBlocks[event.index];
          if (blk) blk.jsonBuf += event.delta.partial_json;
        }
      } else if (event.type === "content_block_stop") {
        const blk = pendingBlocks[event.index];
        if (blk && blk.type === "tool_use") {
          let input = {};
          try {
            input = blk.jsonBuf ? JSON.parse(blk.jsonBuf) : {};
          } catch (e) {
            input = {};
          }
          handlers.onToolCallStart({ id: blk.id, name: blk.name, input });
          const output = this._executeTool(blk.name, input);
          handlers.onToolCallEnd({ id: blk.id, output });
          toolResults.push({ type: "tool_result", tool_use_id: blk.id, content: JSON.stringify(output) });
        }
      }
    }

    const message = await stream.finalMessage();
    this.history.push({ role: "assistant", content: message.content });

    if (message.stop_reason === "tool_use" && toolResults.length) {
      this.history.push({ role: "user", content: toolResults });
      return "continue";
    }
    return "done";
  }

  _executeTool(name, input) {
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

  _handleError(err, handlers) {
    let message = "I couldn't reach Claude just now. Please try again in a moment.";
    if (err instanceof Anthropic.AuthenticationError) {
      message = "That API key doesn't seem to work — check it in Settings.";
    } else if (err instanceof Anthropic.RateLimitError) {
      message = "Claude is rate-limiting this key right now — try again shortly.";
    } else if (err instanceof Anthropic.APIError) {
      message = `Claude API error: ${err.message}`;
    }
    handlers.onTextDelta(message);
  }

  async _streamText(text, onTextDelta) {
    const words = text.split(/(\s+)/);
    for (const word of words) {
      onTextDelta(word);
      await new Promise((r) => setTimeout(r, 16 + Math.random() * 30));
    }
  }

  _isCrisis(text) {
    return CRISIS_PATTERNS.some((pattern) => pattern.test(text));
  }
}
