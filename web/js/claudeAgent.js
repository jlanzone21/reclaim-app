/**
 * ClaudeAgent — Reclaim agent backed by the Claude API, called directly
 * from this device using the user's own API key (see settingsStore.js),
 * with tool-calling against the local SQLite resource database
 * (resourceRepo.js via agentTools.js) so every recommendation is grounded
 * in real data rather than invented by the model.
 *
 * Implements the shared agent event contract (see resourcesAgent.js):
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
const CLAUDE_TOOLS = AGENT_TOOL_DEFS.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.parameters,
}));

class ClaudeAgent {
  constructor(apiKey, model) {
    this.client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    this.model = model || "claude-sonnet-5";
    this.history = [];
    this._idCounter = 0;
  }

  async send(userText, handlers) {
    if (agentIsCrisis(userText)) {
      handlers.onCrisis({ lines: CRISIS_LINES });
      this.history.push({ role: "user", content: userText });
      const reply =
        "I'm really glad you told me. Please reach out to one of the numbers above right now, or call 911 if you're in immediate danger — a trained person can help in a way I can't. You don't have to go through this moment alone.";
      await agentStreamText(reply, handlers.onTextDelta);
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
      system: AGENT_SYSTEM_PROMPT,
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
          const output = executeAgentTool(blk.name, input);
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
}
