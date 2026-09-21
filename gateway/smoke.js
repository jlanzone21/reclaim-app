"use strict";
// End-to-end check of a running gateway (local or through the tunnel).
// Usage: GATEWAY_API_KEY=... node smoke.js [baseUrl]   (default http://127.0.0.1:8787)

const base = (process.argv[2] || "http://127.0.0.1:8787").replace(/\/+$/, "");
const key = process.env.GATEWAY_API_KEY;
if (!key) {
  console.error("Set GATEWAY_API_KEY");
  process.exit(1);
}
const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };

async function streamChat(messages) {
  const res = await fetch(`${base}/v1/chat`, { method: "POST", headers, body: JSON.stringify({ messages }) });
  if (!res.ok) throw new Error(`chat failed: ${res.status} ${await res.text()}`);

  let text = "";
  let done = false;
  let buf = "";
  const calls = [];
  const decoder = new TextDecoder();

  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, end);
      buf = buf.slice(end + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") {
        done = true;
        continue;
      }
      const delta = JSON.parse(data).choices?.[0]?.delta ?? {};
      if (delta.content) {
        text += delta.content;
        process.stdout.write(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const c = (calls[tc.index ?? 0] ??= { id: "", name: "", args: "" });
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.name = tc.function.name;
        if (tc.function?.arguments) c.args += tc.function.arguments;
      }
    }
  }
  if (!done) throw new Error("stream ended without [DONE]");
  return { text, calls: calls.filter(Boolean) };
}

(async () => {
  const status = await fetch(`${base}/v1/status`, { headers });
  console.log("status:", status.status, await status.text());

  const messages = [{ role: "user", content: "Can you give me a Bible verse about hope?" }];
  console.log("\n--- turn 1 ---");
  const first = await streamChat(messages);
  if (!first.calls.length) {
    console.log("\n(model answered without calling a tool)");
    return;
  }
  console.log("\ntool calls:", first.calls.map((c) => `${c.name}(${c.args})`).join(", "));

  const calls = first.calls.map((c, i) => ({ id: c.id || `call_${i}`, type: "function", function: { name: c.name, arguments: c.args || "{}" } }));
  messages.push({ role: "assistant", content: first.text, tool_calls: calls });
  for (const c of calls) {
    messages.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify({ reference: "Psalm 46:1", text: "God is our refuge and strength, an ever-present help in trouble." }) });
  }

  console.log("\n--- turn 2 (after tool result) ---");
  await streamChat(messages);
  console.log("\n\nOK");
})().catch((e) => {
  console.error("\nFAILED:", e.message);
  process.exit(1);
});
