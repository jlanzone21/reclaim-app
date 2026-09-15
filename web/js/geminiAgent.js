/**
 * GeminiAgent — Reclaim agent backed by the Gemini API, called directly
 * from this device with the user's own key. Same event contract and shared
 * tools/prompt as ClaudeAgent — see claudeAgent.js for the contract doc.
 *
 * Not token-streamed: the Gemini Developer API (a personal API key, as
 * opposed to a Vertex AI/enterprise setup) doesn't support combining
 * real-time streaming with function calling, and tool-calling is the part
 * that actually matters here (grounding answers in the real resource
 * database). So this agent makes a normal (non-streaming) request per turn
 * and reveals the final text client-side word-by-word via agentStreamText
 * — visually indistinguishable from real streaming, just not token-level
 * under the hood.
 */
const GEMINI_TOOLS = AGENT_TOOL_DEFS.map((t) => ({
  name: t.name,
  description: t.description,
  parametersJsonSchema: t.parameters,
}));

class GeminiAgent {
  constructor(apiKey, model) {
    this.ai = new GoogleGenAI({ apiKey });
    this.model = model || "gemini-3.5-flash";
    this.chat = null;
    this._idCounter = 0;
  }

  _ensureChat() {
    if (!this.chat) {
      this.chat = this.ai.chats.create({
        model: this.model,
        config: {
          systemInstruction: AGENT_SYSTEM_PROMPT,
          tools: [{ functionDeclarations: GEMINI_TOOLS }],
          automaticFunctionCalling: { disable: true },
        },
      });
    }
    return this.chat;
  }

  async send(userText, handlers) {
    if (agentIsCrisis(userText)) {
      handlers.onCrisis({ lines: CRISIS_LINES });
      const reply =
        "I'm really glad you told me. Please reach out to one of the numbers above right now, or call 911 if you're in immediate danger — a trained person can help in a way I can't. You don't have to go through this moment alone.";
      await agentStreamText(reply, handlers.onTextDelta);
      handlers.onDone();
      return;
    }

    const chat = this._ensureChat();

    try {
      let message = userText;
      let guard = 0;
      while (guard++ < 6) {
        const response = await chat.sendMessage({ message });
        const calls = response.functionCalls;

        if (calls && calls.length) {
          const responseParts = [];
          for (const call of calls) {
            const id = `tool_${++this._idCounter}`;
            const input = call.args || {};
            handlers.onToolCallStart({ id, name: call.name, input });
            const output = executeAgentTool(call.name, input);
            handlers.onToolCallEnd({ id, output });
            responseParts.push({ functionResponse: { name: call.name, response: output } });
          }
          message = responseParts;
          continue;
        }

        await agentStreamText(response.text || "", handlers.onTextDelta);
        break;
      }
    } catch (err) {
      this._handleError(err, handlers);
    }
    handlers.onDone();
  }

  _handleError(err, handlers) {
    let message = "I couldn't reach Gemini just now. Please try again in a moment.";
    if (err instanceof GoogleGenAIApiError) {
      if (err.status === 400 || err.status === 401 || err.status === 403) {
        message = "That API key doesn't seem to work — check it in Settings.";
      } else if (err.status === 429) {
        message = "Gemini is rate-limiting this key right now — try again shortly.";
      } else {
        message = `Gemini API error: ${err.message}`;
      }
    }
    handlers.onTextDelta(message);
  }
}
