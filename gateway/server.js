"use strict";
// Reclaim AI gateway: a constrained, authenticated proxy in front of a local OpenAI-compatible LLM (Ollama).

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const DEFAULT_ORIGINS = [
  "https://reclaim128.org",
  "https://www.reclaim128.org",
  "https://localhost", // Capacitor Android WebView
  "http://localhost:4173", // local dev server (.claude/launch.json)
  "null", // Electron loads web/ from file://
].join(",");

class HttpError extends Error {
  constructor(status, code, message, headers) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.headers = headers || {};
  }
}

class ClientGone extends Error {}

const bad = (code, message) => new HttpError(400, code, message);

function loadConfig(env = process.env) {
  const num = (name, def, min = 1) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return def;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min) throw new Error(`${name} must be a number >= ${min}`);
    return n;
  };
  const apiKeys = (env.GATEWAY_API_KEYS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!apiKeys.length) throw new Error("GATEWAY_API_KEYS is required (comma-separated). Generate one with: openssl rand -hex 32");
  if (apiKeys.some((k) => k.length < 24)) throw new Error("Each key in GATEWAY_API_KEYS must be at least 24 characters");

  return {
    host: env.HOST || "127.0.0.1",
    port: num("PORT", 8787, 0),
    apiKeys,
    llmBaseUrl: (env.LLM_BASE_URL || "http://127.0.0.1:11434/v1").replace(/\/+$/, ""),
    llmModel: env.LLM_MODEL || "reclaim-qwen",
    llmApiKey: env.LLM_API_KEY || "",
    agentToolsFile: env.AGENT_TOOLS_FILE || path.resolve(__dirname, "../web/js/agentTools.js"),
    systemPromptAppendFile: env.SYSTEM_PROMPT_APPEND_FILE || path.resolve(__dirname, "prompt-append.txt"),
    allowedOrigins: new Set((env.ALLOWED_ORIGINS ?? DEFAULT_ORIGINS).split(",").map((s) => s.trim()).filter(Boolean)),
    maxOutputTokens: num("MAX_OUTPUT_TOKENS", 1024),
    temperature: num("TEMPERATURE", 0.2, 0),
    rateLimitPerMin: num("RATE_LIMIT_PER_MIN", 20),
    maxConcurrent: num("MAX_CONCURRENT", 2),
    maxQueue: num("MAX_QUEUE", 6, 0),
    queueTimeoutMs: num("QUEUE_TIMEOUT_MS", 20000),
    upstreamTimeoutMs: num("UPSTREAM_TIMEOUT_MS", 120000),
    warmIntervalMs: num("WARM_INTERVAL_MS", 240000, 0),
    maxBodyBytes: num("MAX_BODY_BYTES", 1048576),
    maxMessages: num("MAX_MESSAGES", 200),
    maxUserChars: num("MAX_USER_CHARS", 4000),
    maxAssistantChars: num("MAX_ASSISTANT_CHARS", 8000),
    maxToolChars: num("MAX_TOOL_CHARS", 24000),
    maxTotalChars: num("MAX_TOTAL_CHARS", 32000),
  };
}

// agentTools.js is a browser script; run it in an empty context so the app and gateway share one prompt and tool list.
function loadAgentTools(file) {
  const ctx = vm.createContext(Object.create(null));
  vm.runInContext(fs.readFileSync(file, "utf8"), ctx, { filename: file, timeout: 1000 });
  const raw = vm.runInContext("JSON.stringify({ defs: AGENT_TOOL_DEFS, prompt: AGENT_SYSTEM_PROMPT })", ctx);
  const { defs, prompt } = JSON.parse(raw);
  if (!Array.isArray(defs) || !defs.length || typeof prompt !== "string" || !prompt) {
    throw new Error(`${file} did not define AGENT_TOOL_DEFS and AGENT_SYSTEM_PROMPT`);
  }
  return { defs, prompt };
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function sanitizeMessages(input, cfg, toolNames) {
  if (!Array.isArray(input) || input.length === 0) throw bad("invalid_messages", "messages must be a non-empty array");
  if (input.length > cfg.maxMessages) throw bad("too_many_messages", `at most ${cfg.maxMessages} messages`);

  const out = [];
  let pending = new Set(); // tool_call ids a following tool message may answer

  for (const m of input) {
    if (!m || typeof m !== "object" || Array.isArray(m)) throw bad("invalid_message", "each message must be an object");

    if (m.role === "user") {
      if (typeof m.content !== "string" || !m.content.trim()) throw bad("invalid_message", "user content must be non-empty text");
      if (m.content.length > cfg.maxUserChars) {
        throw new HttpError(413, "message_too_long", `messages are limited to ${cfg.maxUserChars} characters`);
      }
      out.push({ role: "user", content: m.content });
      pending = new Set();
    } else if (m.role === "assistant") {
      const content = m.content == null ? "" : m.content;
      if (typeof content !== "string" || content.length > cfg.maxAssistantChars) throw bad("invalid_message", "invalid assistant content");
      const msg = { role: "assistant", content };
      pending = new Set();
      if (m.tool_calls !== undefined && m.tool_calls !== null) {
        if (!Array.isArray(m.tool_calls) || m.tool_calls.length < 1 || m.tool_calls.length > 8) {
          throw bad("invalid_tool_calls", "tool_calls must contain 1-8 items");
        }
        msg.tool_calls = m.tool_calls.map((tc) => {
          const fn = tc && tc.function;
          if (!tc || typeof tc.id !== "string" || !ID_RE.test(tc.id) || !fn || !toolNames.has(fn.name)) {
            throw bad("invalid_tool_calls", "unrecognized tool call");
          }
          if (typeof fn.arguments !== "string" || fn.arguments.length > 2000) throw bad("invalid_tool_calls", "invalid tool arguments");
          let args;
          try {
            args = JSON.parse(fn.arguments || "{}");
          } catch {
            throw bad("invalid_tool_calls", "tool arguments must be JSON");
          }
          if (args === null || typeof args !== "object" || Array.isArray(args)) throw bad("invalid_tool_calls", "tool arguments must be an object");
          pending.add(tc.id);
          return { id: tc.id, type: "function", function: { name: fn.name, arguments: JSON.stringify(args) } };
        });
      }
      if (!content && !msg.tool_calls) throw bad("invalid_message", "empty assistant message");
      out.push(msg);
    } else if (m.role === "tool") {
      if (typeof m.tool_call_id !== "string" || !pending.has(m.tool_call_id)) {
        throw bad("invalid_tool_result", "tool result does not answer a preceding tool call");
      }
      if (typeof m.content !== "string") throw bad("invalid_tool_result", "tool result content must be a string");
      if (m.content.length > cfg.maxToolChars) throw new HttpError(413, "tool_result_too_long", "tool result is too large");
      out.push({ role: "tool", tool_call_id: m.tool_call_id, content: m.content });
      pending.delete(m.tool_call_id);
    } else {
      throw bad("invalid_role", "role must be user, assistant, or tool");
    }
  }

  if (out[0].role !== "user") throw bad("invalid_history", "history must start with a user message");
  const last = out[out.length - 1];
  if (last.role !== "user" && last.role !== "tool") throw bad("invalid_history", "last message must be a user message or tool result");
  return out;
}

const sizeOf = (m) =>
  (m.content ? m.content.length : 0) +
  (m.tool_calls ? m.tool_calls.reduce((n, t) => n + t.function.name.length + t.function.arguments.length + 20, 0) : 0);

// Drops whole oldest turns (user message through its tool exchange) so tool calls never lose their results.
function trimToBudget(messages, budget) {
  let total = messages.reduce((n, m) => n + sizeOf(m), 0);
  let start = 0;
  while (total > budget) {
    let next = start + 1;
    while (next < messages.length && messages[next].role !== "user") next++;
    if (next >= messages.length) return null;
    for (let i = start; i < next; i++) total -= sizeOf(messages[i]);
    start = next;
  }
  return messages.slice(start);
}

function createRateLimiter(perMin, now = Date.now) {
  const buckets = new Map();
  const perMs = perMin / 60000;
  return {
    take(key) {
      const t = now();
      let b = buckets.get(key);
      if (!b) {
        b = { tokens: perMin, last: t };
        buckets.set(key, b);
      }
      b.tokens = Math.min(perMin, b.tokens + (t - b.last) * perMs);
      b.last = t;
      if (b.tokens < 1) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - b.tokens) / perMs / 1000)) };
      b.tokens -= 1;
      return { ok: true };
    },
    prune() {
      const t = now();
      for (const [k, b] of buckets) if (t - b.last > 600000) buckets.delete(k);
    },
  };
}

function createGate(max, maxQueue, waitMs) {
  let active = 0;
  const waiting = [];
  const busy = () => new HttpError(503, "busy", "The assistant is busy, please try again shortly", { "retry-after": "5" });

  function makeRelease() {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      active--;
      while (waiting.length && active < max) {
        const e = waiting.shift();
        e.cleanup();
        active++;
        e.resolve(makeRelease());
      }
    };
  }

  return {
    get active() {
      return active;
    },
    get queued() {
      return waiting.length;
    },
    acquire(signal) {
      if (signal && signal.aborted) return Promise.reject(signal.reason);
      if (active < max) {
        active++;
        return Promise.resolve(makeRelease());
      }
      if (waiting.length >= maxQueue) return Promise.reject(busy());
      return new Promise((resolve, reject) => {
        const entry = { resolve };
        const leave = () => {
          const i = waiting.indexOf(entry);
          if (i >= 0) waiting.splice(i, 1);
          entry.cleanup();
        };
        const timer = setTimeout(() => {
          leave();
          reject(busy());
        }, waitMs);
        const onAbort = () => {
          leave();
          reject(signal.reason);
        };
        entry.cleanup = () => {
          clearTimeout(timer);
          if (signal) signal.removeEventListener("abort", onAbort);
        };
        if (signal) signal.addEventListener("abort", onAbort, { once: true });
        waiting.push(entry);
      });
    },
  };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on("data", (c) => {
      if (over) return;
      size += c.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        reject(new HttpError(413, "body_too_large", "Request body is too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, body, headers) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(data);
}

function corsHeaders(origin, allowed) {
  const h = { vary: "Origin" };
  if (origin && allowed) {
    h["access-control-allow-origin"] = origin;
    h["access-control-allow-headers"] = "authorization, content-type";
    h["access-control-allow-methods"] = "GET, POST, OPTIONS";
    h["access-control-expose-headers"] = "retry-after";
    h["access-control-max-age"] = "600";
  }
  return h;
}

// CF-Connecting-IP is only trustworthy because the gateway listens on loopback and is reached solely through cloudflared.
function clientIp(req) {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.trim()) return cf.trim();
  return req.socket.remoteAddress || "unknown";
}

const sha256 = (s) => crypto.createHash("sha256").update(s).digest();

function createGateway(cfg, { log = (evt) => console.log(JSON.stringify({ t: new Date().toISOString(), ...evt })) } = {}) {
  const { defs, prompt } = loadAgentTools(cfg.agentToolsFile);
  const toolNames = new Set(defs.map((d) => d.name));
  const openaiTools = defs.map((d) => ({ type: "function", function: { name: d.name, description: d.description, parameters: d.parameters } }));
  const append = fs.existsSync(cfg.systemPromptAppendFile) ? fs.readFileSync(cfg.systemPromptAppendFile, "utf8").trim() : "";
  const systemPrompt = append ? `${prompt}\n\n${append}` : prompt;
  const keyDigests = cfg.apiKeys.map(sha256);
  const limiter = createRateLimiter(cfg.rateLimitPerMin);
  const gate = createGate(cfg.maxConcurrent, cfg.maxQueue, cfg.queueTimeoutMs);
  const salt = crypto.randomBytes(16);
  const ipTag = (ip) => crypto.createHmac("sha256", salt).update(ip).digest("hex").slice(0, 8);
  const pruneTimer = setInterval(limiter.prune, 60000);
  pruneTimer.unref();
  let warmTimer = null;

  const upstreamHeaders = () => ({
    "content-type": "application/json",
    ...(cfg.llmApiKey ? { authorization: `Bearer ${cfg.llmApiKey}` } : {}),
  });

  function requireAuth(req) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
    const digest = m ? sha256(m[1].trim()) : null;
    let ok = false;
    for (const kd of keyDigests) if (digest && crypto.timingSafeEqual(kd, digest)) ok = true;
    if (!ok) throw new HttpError(401, "unauthorized", "Missing or invalid API key", { "www-authenticate": "Bearer" });
  }

  function takeRateLimit(ip) {
    const rl = limiter.take(ip);
    if (!rl.ok) throw new HttpError(429, "rate_limited", "Too many requests", { "retry-after": String(rl.retryAfterSec) });
  }

  async function readChatRequest(req) {
    const ct = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (ct !== "application/json") throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json");
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > cfg.maxBodyBytes) throw new HttpError(413, "body_too_large", "Request body is too large");
    const raw = await readBody(req, cfg.maxBodyBytes);
    let body;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      throw bad("invalid_json", "Body must be valid JSON");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("invalid_json", "Body must be a JSON object");
    const clean = sanitizeMessages(body.messages, cfg, toolNames);
    const trimmed = trimToBudget(clean, cfg.maxTotalChars);
    if (!trimmed) throw new HttpError(413, "conversation_too_long", "The latest turn is too large to process");
    return trimmed;
  }

  async function handleChat(req, res, ctx) {
    takeRateLimit(ctx.ip);
    requireAuth(req);
    const messages = await readChatRequest(req);
    const payload = {
      model: cfg.llmModel,
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      tools: openaiTools,
      stream: true,
      max_tokens: cfg.maxOutputTokens,
      temperature: cfg.temperature,
    };

    const ac = new AbortController();
    const onClose = () => {
      if (!res.writableFinished) ac.abort(new ClientGone());
    };
    res.on("close", onClose);
    let release = null;
    let timer = null;
    try {
      release = await gate.acquire(ac.signal);
      timer = setTimeout(() => ac.abort(new HttpError(504, "llm_timeout", "The assistant took too long to respond")), cfg.upstreamTimeoutMs);

      let upstream;
      try {
        upstream = await fetch(`${cfg.llmBaseUrl}/chat/completions`, {
          method: "POST",
          headers: upstreamHeaders(),
          body: JSON.stringify(payload),
          signal: ac.signal,
        });
      } catch {
        throw ac.signal.aborted ? ac.signal.reason : new HttpError(503, "llm_unavailable", "The assistant is offline right now");
      }
      if (!upstream.ok) {
        await upstream.body?.cancel().catch(() => {});
        log({ ev: "upstream_status", status: upstream.status });
        throw new HttpError(502, "llm_error", "The assistant returned an error");
      }

      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store, no-transform",
        "x-accel-buffering": "no",
        "x-content-type-options": "nosniff",
        ...ctx.cors,
      });
      res.flushHeaders();
      try {
        await pipeline(Readable.fromWeb(upstream.body), res);
      } catch {
        // Client left or upstream broke mid-stream; a stream that ends without [DONE] is treated as failed by the client.
      }
    } catch (err) {
      if (ac.signal.aborted && ac.signal.reason instanceof ClientGone) throw ac.signal.reason;
      throw err;
    } finally {
      clearTimeout(timer);
      res.off("close", onClose);
      if (release) release();
    }
  }

  async function handleStatus(req, res, ctx) {
    takeRateLimit(ctx.ip);
    requireAuth(req);
    let llm = "down";
    try {
      const r = await fetch(`${cfg.llmBaseUrl}/models`, { headers: upstreamHeaders(), signal: AbortSignal.timeout(2000) });
      if (r.ok) {
        const j = await r.json();
        const has = Array.isArray(j.data) && j.data.some((m) => m.id === cfg.llmModel || m.id === `${cfg.llmModel}:latest`);
        llm = has ? "up" : "model_missing";
      }
    } catch {
      llm = "down";
    }
    sendJson(res, 200, { ok: llm === "up", llm, model: cfg.llmModel, active: gate.active, queued: gate.queued }, ctx.cors);
  }

  async function handle(req, res) {
    const started = Date.now();
    const ip = clientIp(req);
    const route = `${req.method} ${new URL(req.url, "http://gateway.local").pathname}`;
    const origin = req.headers.origin;
    const originOk = !origin || cfg.allowedOrigins.has(origin);
    const ctx = { ip, cors: corsHeaders(origin, originOk) };
    req.on("error", () => {});
    // Never log message content: request metadata only.
    res.on("close", () => log({ ev: "req", route, status: res.statusCode, ms: Date.now() - started, ip: ipTag(ip), cut: !res.writableFinished }));

    if (!originOk) return sendJson(res, 403, { error: "origin_not_allowed" }, ctx.cors);
    if (req.method === "OPTIONS") {
      res.writeHead(204, ctx.cors);
      return res.end();
    }
    if (route === "GET /healthz") return sendJson(res, 200, { ok: true }, ctx.cors);
    if (route === "GET /v1/status") return handleStatus(req, res, ctx);
    if (route === "POST /v1/chat") return handleChat(req, res, ctx);
    return sendJson(res, 404, { error: "not_found" }, ctx.cors);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (err instanceof ClientGone || res.headersSent) {
        res.destroy();
        return;
      }
      const cors = corsHeaders(req.headers.origin, !req.headers.origin || cfg.allowedOrigins.has(req.headers.origin));
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.code, message: err.message }, { ...cors, ...err.headers });
      log({ ev: "error", name: err && err.name, code: err && err.code });
      sendJson(res, 500, { error: "internal_error" }, cors);
    });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.on("close", () => {
    clearInterval(pruneTimer);
    clearInterval(warmTimer);
  });

  // Keeps the model resident: Ollama unloads idle models after a few minutes and the next chat would wait for a reload.
  async function warm() {
    if (gate.active > 0) return;
    try {
      const r = await fetch(`${cfg.llmBaseUrl}/chat/completions`, {
        method: "POST",
        headers: upstreamHeaders(),
        body: JSON.stringify({ model: cfg.llmModel, messages: [{ role: "user", content: "hi" }], max_tokens: 1, stream: false }),
        signal: AbortSignal.timeout(90000),
      });
      await r.arrayBuffer();
    } catch {
      // Model server not up yet; the next interval or real request will retry.
    }
  }

  function start() {
    return new Promise((resolve) => {
      server.listen(cfg.port, cfg.host, () => {
        if (cfg.warmIntervalMs > 0) {
          warm();
          warmTimer = setInterval(warm, cfg.warmIntervalMs);
          warmTimer.unref();
        }
        resolve();
      });
    });
  }

  return { server, start, close: () => new Promise((resolve) => (server.close(resolve), server.closeAllConnections())), tools: defs.map((d) => d.name) };
}

module.exports = { createGateway, loadConfig, sanitizeMessages, trimToBudget, createRateLimiter, createGate };

if (require.main === module) {
  const cfg = loadConfig();
  const gw = createGateway(cfg);
  if (cfg.host !== "127.0.0.1" && cfg.host !== "localhost" && cfg.host !== "::1") {
    console.warn(`WARNING: listening on ${cfg.host}; CF-Connecting-IP is only trustworthy when the gateway is reachable solely via the tunnel`);
  }
  gw.start().then(() => {
    console.log(JSON.stringify({ t: new Date().toISOString(), ev: "listening", host: cfg.host, port: cfg.port, model: cfg.llmModel, upstream: cfg.llmBaseUrl, tools: gw.tools.length }));
  });
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => gw.close().then(() => process.exit(0)));
  }
}
