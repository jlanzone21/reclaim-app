// Runs Reclaim's AI inside this page with WebLLM; the 6 MB library (js/vendor/web-llm.js) loads only once the AI is turned on.
const LocalModel = (function () {
  const MODEL = { base: "Qwen3.5-2B", downloadMB: 1030 };
  const ENABLED_KEY = "reclaim_ai_enabled";

  let status = { state: "checking", detail: "", progress: 0, downloadMB: MODEL.downloadMB };
  let modelId = null;
  let appConfig = null;
  let engine = null;
  let starting = null;
  const listeners = new Set();

  function set(state, detail = "", progress = status.progress) {
    status = { state, detail, progress, downloadMB: MODEL.downloadMB };
    listeners.forEach((fn) => fn(status));
  }

  function onChange(fn) {
    listeners.add(fn);
    fn(status);
  }

  async function checkSupport() {
    if (!navigator.gpu) return { ok: false, reason: "This device's browser doesn't support WebGPU, which the AI needs." };
    let adapter = null;
    try {
      adapter = await navigator.gpu.requestAdapter();
    } catch (e) {}
    if (!adapter) return { ok: false, reason: "No compatible graphics processor was found on this device." };
    return { ok: true, f16: adapter.features.has("shader-f16") };
  }

  function loadLibrary() {
    if (window.webllm) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "js/vendor/web-llm.js";
      s.onload = resolve;
      s.onerror = () => reject(new Error("Couldn't load the AI library."));
      document.head.appendChild(s);
    });
  }

  // Cache Storage isn't available everywhere (e.g. some file:// contexts); IndexedDB is the fallback WebLLM supports.
  async function pickCacheBackend() {
    try {
      await caches.open("reclaim-probe");
      await caches.delete("reclaim-probe");
      return "cache";
    } catch (e) {
      return "indexeddb";
    }
  }

  async function prepare() {
    await loadLibrary();
    if (!appConfig) appConfig = { ...webllm.prebuiltAppConfig, cacheBackend: await pickCacheBackend() };
  }

  async function init() {
    const support = await checkSupport();
    if (!support.ok) return set("unsupported", support.reason);
    modelId = `${MODEL.base}-${support.f16 ? "q4f16_1" : "q4f32_1"}-MLC`;

    let wanted = false;
    try {
      wanted = localStorage.getItem(ENABLED_KEY) === "1";
    } catch (e) {}
    if (!wanted) return set("available");

    try {
      await prepare();
      // Only reload automatically when it's already downloaded: never start a large download without a tap.
      if (await webllm.hasModelInCache(modelId, appConfig)) return start();
    } catch (e) {}
    set("available");
  }

  function start() {
    if (starting) return starting;
    starting = (async () => {
      try {
        await prepare();
        const cached = await webllm.hasModelInCache(modelId, appConfig);
        set(cached ? "loading" : "downloading", "", 0);
        try {
          localStorage.setItem(ENABLED_KEY, "1");
        } catch (e) {}
        engine = await webllm.CreateMLCEngine(modelId, {
          appConfig,
          initProgressCallback: (report) => set(status.state, report.text || "", report.progress || 0),
        });
        set("ready", "", 1);
      } catch (err) {
        engine = null;
        set("error", friendlyError(err));
      } finally {
        starting = null;
      }
    })();
    return starting;
  }

  function friendlyError(err) {
    const msg = String((err && err.message) || err || "");
    if (/memory|OOM|allocation|device lost|DeviceLost/i.test(msg)) return "This device doesn't have enough graphics memory to run the AI.";
    if (/network|fetch|Failed to fetch|NetworkError/i.test(msg)) return "The download was interrupted. Check your connection and try again.";
    if (/quota|storage/i.test(msg)) return "There isn't enough free storage on this device for the AI.";
    return "The AI couldn't start on this device.";
  }

  function isReady() {
    return status.state === "ready" && !!engine;
  }

  // Qwen3 can open its reply with a <think> block even when thinking is off; it's never shown.
  function visibleText(raw) {
    return raw.replace(/^\s*<think>[\s\S]*?(<\/think>\s*|$)/, "");
  }

  async function streamChat(messages, { maxTokens = 200, temperature = 0.3, onDelta }) {
    const stream = await engine.chat.completions.create({
      messages,
      stream: true,
      max_tokens: maxTokens,
      temperature,
      frequency_penalty: 0.4,
      extra_body: { enable_thinking: false },
    });
    let raw = "";
    let sent = "";
    for await (const chunk of stream) {
      const delta = chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content;
      if (!delta) continue;
      raw += delta;
      const visible = visibleText(raw);
      if (visible.startsWith(sent) && visible.length > sent.length) {
        onDelta(visible.slice(sent.length));
        sent = visible;
      }
    }
    return sent;
  }

  async function chooseJson(messages, schema) {
    const reply = await engine.chat.completions.create({
      messages,
      max_tokens: 80,
      temperature: 0,
      response_format: { type: "json_object", schema: JSON.stringify(schema) },
      extra_body: { enable_thinking: false },
    });
    return JSON.parse(visibleText(reply.choices[0].message.content || ""));
  }

  return { init, start, onChange, isReady, streamChat, chooseJson, getStatus: () => status };
})();
