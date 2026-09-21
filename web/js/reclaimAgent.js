// Reclaim's only AI agent: streams from the gateway (gateway/server.js) and runs tool calls here, against ResourceRepo.
const RECLAIM_TOOL_NAMES = new Set(AGENT_TOOL_DEFS.map((t) => t.name));
const RECLAIM_CALL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const RECLAIM_MAX_TURNS = 12;
const RECLAIM_MAX_TOOL_ROUNDS = 6;
const RECLAIM_TIMEOUT_MS = 90000;

class ReclaimAIError extends Error {
  constructor(kind, status, code) {
    super(`${kind}${status ? ` (${status}${code ? ` ${code}` : ""})` : ""}`);
    this.kind = kind; // "unavailable" | "rejected" | "too_long" | "empty"
    this.status = status;
    this.code = code;
  }
}

class ReclaimAgent {
  constructor({ onStatus } = {}) {
    this.history = [];
    this.fallback = new ResourcesAgent();
    this.onStatus = onStatus || (() => {});
  }

  async checkStatus() {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000);
    try {
      const res = await fetch(`${RECLAIM_AI_URL}/v1/status`, {
        headers: { authorization: `Bearer ${RECLAIM_AI_KEY}` },
        signal: ac.signal,
      });
      const body = res.ok ? await res.json() : null;
      this.onStatus(body && body.ok ? "online" : "basic");
    } catch (e) {
      this.onStatus("basic");
    } finally {
      clearTimeout(timer);
    }
  }

  async send(userText, handlers) {
    // Crisis detection must run before any network call and never depend on the model.
    if (agentIsCrisis(userText)) {
      handlers.onCrisis({ lines: CRISIS_LINES });
      await agentStreamText(CRISIS_REPLY, handlers.onTextDelta);
      this.history.push({ role: "user", content: userText }, { role: "assistant", content: CRISIS_REPLY });
      handlers.onDone();
      return;
    }

    this._trimHistory();
    const checkpoint = this.history.length;
    this.history.push({ role: "user", content: userText });

    let shown = false;
    const onTextDelta = (chunk) => {
      shown = true;
      handlers.onTextDelta(chunk);
    };

    try {
      for (let round = 0; round < RECLAIM_MAX_TOOL_ROUNDS; round++) {
        const { text, calls } = await this._request(onTextDelta);
        const valid = calls.filter((c) => RECLAIM_TOOL_NAMES.has(c.name));
        if (!text && !valid.length) {
          if (round === 0) throw new ReclaimAIError("empty");
          break;
        }

        const message = { role: "assistant", content: text };
        if (valid.length) {
          message.tool_calls = valid.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          }));
        }
        this.history.push(message);
        if (!valid.length) break;

        for (const c of valid) {
          shown = true;
          handlers.onToolCallStart({ id: c.id, name: c.name, input: c.args });
          const output = executeAgentTool(c.name, c.args);
          handlers.onToolCallEnd({ id: c.id, output });
          this.history.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(output) });
        }
      }
      this.onStatus("online");
    } catch (err) {
      this.history.length = checkpoint;
      if (err.kind === "rejected") this.history = [];

      if (err.kind === "too_long") {
        handlers.onTextDelta("That message is a bit too long for me — could you shorten it?");
      } else if (shown) {
        handlers.onTextDelta("\n\n(The connection dropped before I finished — please try again.)");
      } else {
        if (err.kind === "unavailable") this.onStatus("basic");
        console.warn("Reclaim AI unavailable, using the built-in guide:", err.message);
        await this.fallback.send(userText, handlers);
        return;
      }
    }
    handlers.onDone();
  }

  // Drops whole oldest turns so every tool result stays paired with the call that produced it.
  _trimHistory() {
    let turns = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].role === "user" && ++turns === RECLAIM_MAX_TURNS) {
        this.history = this.history.slice(i);
        return;
      }
    }
  }

  async _request(onTextDelta) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), RECLAIM_TIMEOUT_MS);
    try {
      let res;
      try {
        res = await fetch(`${RECLAIM_AI_URL}/v1/chat`, {
          method: "POST",
          headers: { authorization: `Bearer ${RECLAIM_AI_KEY}`, "content-type": "application/json" },
          body: JSON.stringify({ messages: this.history }),
          signal: ac.signal,
        });
      } catch (e) {
        throw new ReclaimAIError("unavailable", 0);
      }

      if (!res.ok) {
        let code = "";
        try {
          code = (await res.json()).error || "";
        } catch (e) {}
        if (code === "message_too_long") throw new ReclaimAIError("too_long", res.status, code);
        const rejected = res.status === 400 || res.status === 413;
        throw new ReclaimAIError(rejected ? "rejected" : "unavailable", res.status, code);
      }

      return await this._readStream(res.body, onTextDelta);
    } finally {
      clearTimeout(timer);
    }
  }

  // Parses the gateway's OpenAI-style SSE; a stream that ends without [DONE] counts as a failure.
  async _readStream(body, onTextDelta) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const calls = [];
    let buf = "";
    let text = "";
    let done = false;

    try {
      for (;;) {
        const { value, done: ended } = await reader.read();
        if (ended) break;
        buf = (buf + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");

        let cut;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") {
              done = true;
              continue;
            }
            let delta;
            try {
              delta = JSON.parse(data).choices[0].delta;
            } catch (e) {
              continue;
            }
            if (!delta) continue;
            if (delta.content) {
              text += delta.content;
              onTextDelta(delta.content);
            }
            for (const tc of delta.tool_calls || []) {
              const i = tc.index == null ? 0 : tc.index;
              const call = calls[i] || (calls[i] = { id: "", name: "", args: "" });
              if (tc.id) call.id = tc.id;
              if (tc.function && tc.function.name) call.name = tc.function.name;
              if (tc.function && tc.function.arguments) call.args += tc.function.arguments;
            }
          }
        }
      }
    } catch (e) {
      throw new ReclaimAIError("unavailable", 0);
    }
    if (!done) throw new ReclaimAIError("unavailable", 0);

    return {
      text,
      calls: calls.filter(Boolean).map((c, n) => {
        let args = {};
        try {
          const parsed = JSON.parse(c.args || "{}");
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed;
        } catch (e) {}
        const id = RECLAIM_CALL_ID.test(c.id) ? c.id : `call_${Date.now().toString(36)}_${n}`;
        return { id, name: c.name, args };
      }),
    };
  }
}
