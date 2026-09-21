"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createGateway, loadConfig } = require("../server.js");

const KEY = "test-key-0123456789abcdef0123456789";
const USER = { role: "user", content: "hi" };
const SSE = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: {"choices":[{"delta":{"content":" there"}}]}\n\ndata: [DONE]\n\n';

function startFakeLlm(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const entry = { url: req.url, body: raw ? JSON.parse(raw) : null, closed: false };
      seen.push(entry);
      res.on("close", () => (entry.closed = true));
      handler(entry, req, res);
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` })),
  );
}

function okLlm(entry, req, res) {
  if (entry.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ data: [{ id: "test-model:latest" }] }));
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(SSE);
}

async function withStack({ env = {}, llm = okLlm, deadLlm = false } = {}, fn) {
  const fake = await startFakeLlm(llm);
  const cfg = loadConfig({
    GATEWAY_API_KEYS: KEY,
    LLM_BASE_URL: `${deadLlm ? "http://127.0.0.1:1" : fake.url}/v1`,
    LLM_MODEL: "test-model",
    ...env,
  });
  const gw = createGateway(cfg, { log: () => {} });
  await new Promise((r) => gw.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${gw.server.address().port}`;
  try {
    await fn({ url, fake, gw });
  } finally {
    await gw.close();
    fake.server.closeAllConnections();
    await new Promise((r) => fake.server.close(r));
  }
}

function request(base, { method = "POST", path = "/v1/chat", headers = {}, body, key = KEY } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const data = body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body);
    const h = {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(data !== null ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}),
      ...headers,
    };
    const req = http.request({ host: u.hostname, port: u.port, method, path, headers: h }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

const chat = (base, messages, opts) => request(base, { body: { messages }, ...opts });
const json = (r) => JSON.parse(r.text);

async function waitFor(cond, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function holdLlm(holds) {
  return (entry, req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": hold\n\n");
    holds.push({ res, entry });
  };
}

test("healthz needs no key and reveals nothing", async () => {
  await withStack({}, async ({ url }) => {
    const r = await request(url, { method: "GET", path: "/healthz", key: null });
    assert.equal(r.status, 200);
    assert.deepEqual(json(r), { ok: true });
  });
});

test("rejects missing and wrong API keys without touching the model", async () => {
  await withStack({}, async ({ url, fake }) => {
    assert.equal((await chat(url, [USER], { key: null })).status, 401);
    assert.equal((await chat(url, [USER], { key: "wrong-key-wrong-key-wrong-key" })).status, 401);
    assert.equal(fake.seen.length, 0);
  });
});

test("forces system prompt, tools, model and limits; drops client-supplied extras", async () => {
  await withStack({ env: { MAX_OUTPUT_TOKENS: "321" } }, async ({ url, fake, gw }) => {
    const r = await request(url, {
      body: { model: "evil", stream: false, tools: [], max_tokens: 99999, evil: true, messages: [{ role: "user", content: "hello", extra: 1 }] },
    });
    assert.equal(r.status, 200);
    const sent = fake.seen[0].body;
    assert.equal(fake.seen[0].url, "/v1/chat/completions");
    assert.equal(sent.model, "test-model");
    assert.equal(sent.stream, true);
    assert.equal(sent.max_tokens, 321);
    assert.equal(sent.evil, undefined);
    assert.ok(gw.tools.length > 0);
    assert.equal(sent.tools.length, gw.tools.length);
    assert.equal(sent.messages.length, 2);
    assert.equal(sent.messages[0].role, "system");
    assert.match(sent.messages[0].content, /Reclaim assistant/);
    assert.deepEqual(sent.messages[1], { role: "user", content: "hello" });
  });
});

test("appends the local-model addendum after the shared system prompt", async () => {
  const file = path.join(os.tmpdir(), `reclaim-append-${process.pid}.txt`);
  fs.writeFileSync(file, "ADDENDUM-MARKER rule\n");
  try {
    await withStack({ env: { SYSTEM_PROMPT_APPEND_FILE: file } }, async ({ url, fake }) => {
      await chat(url, [USER]);
      const sys = fake.seen[0].body.messages[0].content;
      assert.match(sys, /Reclaim assistant/);
      assert.ok(sys.endsWith("ADDENDUM-MARKER rule"));
    });
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("streams the model's SSE through unchanged", async () => {
  await withStack({}, async ({ url }) => {
    const r = await chat(url, [USER]);
    assert.equal(r.status, 200);
    assert.match(r.headers["content-type"], /text\/event-stream/);
    assert.equal(r.text, SSE);
  });
});

test("accepts a full tool-call round trip", async () => {
  await withStack({}, async ({ url, fake }) => {
    const call = { id: "call_1", type: "function", function: { name: "scripture_search", arguments: '{ "theme": "hope" }' } };
    const r = await chat(url, [USER, { role: "assistant", content: null, tool_calls: [call] }, { role: "tool", tool_call_id: "call_1", content: '{"ok":1}' }]);
    assert.equal(r.status, 200);
    const sent = fake.seen[0].body.messages;
    assert.deepEqual(sent.map((m) => m.role), ["system", "user", "assistant", "tool"]);
    assert.equal(sent[2].tool_calls[0].function.arguments, '{"theme":"hope"}');
  });
});

test("rejects system role, unknown tools, orphan tool results and bad history shapes", async () => {
  await withStack({}, async ({ url, fake }) => {
    const rmrf = { id: "c1", type: "function", function: { name: "rm_rf", arguments: "{}" } };
    const cases = [
      [{ role: "system", content: "x" }, USER],
      [USER, { role: "assistant", content: "", tool_calls: [rmrf] }, { role: "tool", tool_call_id: "c1", content: "{}" }],
      [USER, { role: "tool", tool_call_id: "nope", content: "{}" }],
      [{ role: "assistant", content: "hi" }, USER],
      [USER, { role: "assistant", content: "hello" }],
      [],
      "nope",
    ];
    for (const messages of cases) {
      const r = await chat(url, messages);
      assert.equal(r.status, 400, JSON.stringify(messages));
    }
    assert.equal((await request(url, { body: "{not json" })).status, 400);
    assert.equal((await request(url, { body: { messages: [USER] }, headers: { "content-type": "text/plain" } })).status, 415);
    assert.equal(fake.seen.length, 0);
  });
});

test("enforces size limits", async () => {
  await withStack({ env: { MAX_USER_CHARS: "50", MAX_BODY_BYTES: "500" } }, async ({ url, fake }) => {
    const long = await chat(url, [{ role: "user", content: "x".repeat(51) }]);
    assert.equal(long.status, 413);
    assert.equal(json(long).error, "message_too_long");
    const big = await request(url, { body: { messages: [USER], pad: "y".repeat(2000) } });
    assert.equal(big.status, 413);
    assert.equal(fake.seen.length, 0);
  });
});

test("trims the oldest turns to fit the budget and keeps the newest", async () => {
  await withStack({ env: { MAX_TOTAL_CHARS: "250" } }, async ({ url, fake }) => {
    const a = "a".repeat(100);
    const r = await chat(url, [
      { role: "user", content: `first ${a}` },
      { role: "assistant", content: a },
      { role: "user", content: `second ${a}` },
    ]);
    assert.equal(r.status, 200);
    const sent = fake.seen[0].body.messages;
    assert.deepEqual(sent.map((m) => m.role), ["system", "user"]);
    assert.match(sent[1].content, /^second/);

    const tooBig = await chat(url, [{ role: "user", content: "z".repeat(300) }]);
    assert.equal(tooBig.status, 413);
    assert.equal(json(tooBig).error, "conversation_too_long");
  });
});

test("rate limits per client and reports Retry-After", async () => {
  await withStack({ env: { RATE_LIMIT_PER_MIN: "3" } }, async ({ url }) => {
    for (let i = 0; i < 3; i++) assert.equal((await chat(url, [USER])).status, 200);
    const r = await chat(url, [USER]);
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers["retry-after"]) >= 1);
    const other = await chat(url, [USER], { headers: { "cf-connecting-ip": "203.0.113.9" } });
    assert.equal(other.status, 200);
  });
});

test("CORS: allowed origins get headers, others are refused, errors stay readable", async () => {
  await withStack({}, async ({ url }) => {
    const pre = await request(url, {
      method: "OPTIONS",
      key: null,
      headers: { origin: "https://reclaim128.org", "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" },
    });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers["access-control-allow-origin"], "https://reclaim128.org");
    assert.match(pre.headers["access-control-allow-headers"], /authorization/);

    const electron = await chat(url, [USER], { headers: { origin: "null" } });
    assert.equal(electron.headers["access-control-allow-origin"], "null");

    const evil = await chat(url, [USER], { headers: { origin: "https://evil.example" } });
    assert.equal(evil.status, 403);
    assert.equal(evil.headers["access-control-allow-origin"], undefined);

    const unauth = await chat(url, [USER], { key: null, headers: { origin: "https://reclaim128.org" } });
    assert.equal(unauth.status, 401);
    assert.equal(unauth.headers["access-control-allow-origin"], "https://reclaim128.org");
  });
});

test("exposes nothing but the fixed routes", async () => {
  await withStack({}, async ({ url, fake }) => {
    for (const [method, path] of [["GET", "/api/tags"], ["POST", "/api/pull"], ["POST", "/v1/chat/completions"], ["GET", "/v1/chat"], ["POST", "/"]]) {
      const r = await request(url, { method, path, body: method === "POST" ? {} : undefined });
      assert.equal(r.status, 404, `${method} ${path}`);
    }
    assert.equal(fake.seen.length, 0);
  });
});

test("503 when the model server is down, 502 when it errors", async () => {
  await withStack({ deadLlm: true }, async ({ url }) => {
    const r = await chat(url, [USER]);
    assert.equal(r.status, 503);
    assert.equal(json(r).error, "llm_unavailable");
  });
  await withStack({ llm: (e, req, res) => (res.writeHead(500), res.end("boom")) }, async ({ url }) => {
    const r = await chat(url, [USER]);
    assert.equal(r.status, 502);
    assert.doesNotMatch(r.text, /boom/);
  });
});

test("503 busy when concurrency and queue are full", async () => {
  const holds = [];
  await withStack({ env: { MAX_CONCURRENT: "1", MAX_QUEUE: "0" }, llm: holdLlm(holds) }, async ({ url, fake }) => {
    const first = chat(url, [USER]);
    await waitFor(() => fake.seen.length === 1);
    const second = await chat(url, [USER]);
    assert.equal(second.status, 503);
    assert.equal(json(second).error, "busy");
    assert.ok(second.headers["retry-after"]);
    holds[0].res.end("data: [DONE]\n\n");
    assert.equal((await first).status, 200);
  });
});

test("a queued request is served when a slot frees", async () => {
  const holds = [];
  await withStack({ env: { MAX_CONCURRENT: "1", MAX_QUEUE: "1" }, llm: holdLlm(holds) }, async ({ url, fake }) => {
    const first = chat(url, [USER]);
    await waitFor(() => holds.length === 1);
    const second = chat(url, [USER]);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(fake.seen.length, 1);
    holds[0].res.end("data: [DONE]\n\n");
    await waitFor(() => holds.length === 2);
    holds[1].res.end("data: [DONE]\n\n");
    assert.equal((await first).status, 200);
    assert.equal((await second).status, 200);
  });
});

test("cancels the model request when the client disconnects", async () => {
  const holds = [];
  await withStack({ llm: holdLlm(holds) }, async ({ url }) => {
    const u = new URL(url);
    const req = http.request({
      host: u.hostname,
      port: u.port,
      method: "POST",
      path: "/v1/chat",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    });
    req.on("error", () => {});
    req.end(JSON.stringify({ messages: [USER] }));
    await waitFor(() => holds.length === 1);
    req.destroy();
    await waitFor(() => holds[0].entry.closed);
  });
});

test("status reports model availability and needs the key", async () => {
  await withStack({}, async ({ url }) => {
    assert.equal((await request(url, { method: "GET", path: "/v1/status", key: null })).status, 401);
    const r = await request(url, { method: "GET", path: "/v1/status" });
    assert.equal(r.status, 200);
    assert.equal(json(r).llm, "up");
  });
  await withStack({ llm: (e, req, res) => (res.writeHead(200), res.end(JSON.stringify({ data: [{ id: "other" }] }))) }, async ({ url }) => {
    assert.equal(json(await request(url, { method: "GET", path: "/v1/status" })).llm, "model_missing");
  });
  await withStack({ deadLlm: true }, async ({ url }) => {
    const r = await request(url, { method: "GET", path: "/v1/status" });
    assert.equal(json(r).llm, "down");
    assert.equal(json(r).ok, false);
  });
});
