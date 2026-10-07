// Runs Reclaim's AI inside this page with WebLLM; the 6 MB library (js/vendor/web-llm.js) loads only once the AI is turned on.
const LocalModel = (function () {
  // downloadMB covers both downloads behind the one AI opt-in: the chat model (~1030 MB) and the
  // embedding model localEmbedder.js loads right after it (67.6 MB measured).
  const MODEL = { base: "Qwen3.5-2B", downloadMB: 1100 };
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
        // The small embedding model loads after chat is usable and never holds it up; if it can't
        // load, matching falls back to keywords + thumbs (see localEmbedder.js).
        if (typeof LocalEmbedder !== "undefined") LocalEmbedder.start(appConfig);
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
    // "disposed" (not just "device lost"/"DeviceLost") because that's what actually reaches a
    // catchable error in practice: WebGPU logs the device-loss event as its own console warning,
    // separate from any exception, and the engine's handles start throwing "already disposed" on
    // the very next call -- confirmed on a real Windows DXGI_ERROR_DEVICE_HUNG (TDR timeout).
    if (/memory|OOM|allocation|device lost|DeviceLost|disposed/i.test(msg))
      return "This device's graphics ran into a problem running the AI — common on weaker or busy graphics hardware.";
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

  // onDelta returning false stops generation early; the rest of the stream is drained so the engine is free for the next call.
  // `raw` is exactly what WebLLM recorded as the reply (empty <think> block included). Sending it back unchanged as the
  // assistant message next turn lets WebLLM reuse its cache instead of re-reading the whole conversation, which is slow on phones.
  // A GPU device-loss (Windows TDR timeout, out-of-memory, etc.) can happen mid-generation, not
  // just at load time -- confirmed on a real DXGI_ERROR_DEVICE_HUNG. WebGPU logs that as its own
  // console warning, not a catchable exception; what actually throws here is the engine's next
  // call failing with "already disposed", since its GPU-backed handles are now invalid. Without
  // this, isReady() keeps reporting true forever and every later message silently fails the same
  // way -- same reset-and-report-error as start()'s own catch block, so the connection badge and
  // its "Try again" action (app.js renderAiStatus) correctly reflect reality, and ReclaimAgent's
  // own isReady() check routes subsequent turns to Basic mode instead of a dead engine.
  function failed(err) {
    console.warn("WebLLM engine failed during generation, resetting:", err);
    engine = null;
    set("error", friendlyError(err));
  }

  async function streamChat(messages, { maxTokens = 160, temperature = 0.3, onDelta }) {
    let stream;
    try {
      stream = await engine.chat.completions.create({
        messages,
        stream: true,
        max_tokens: maxTokens,
        temperature,
        frequency_penalty: 0.4,
        extra_body: { enable_thinking: false },
      });
    } catch (err) {
      failed(err);
      throw err;
    }
    let raw = "";
    let sent = "";
    let stopped = false;
    let finishReason = null;
    try {
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta && choice.delta.content;
        if (!delta) continue;
        raw += delta;
        if (stopped) continue;
        const visible = visibleText(raw);
        if (visible.startsWith(sent) && visible.length > sent.length) {
          const more = onDelta(visible.slice(sent.length));
          sent = visible;
          if (more === false) {
            stopped = true;
            engine.interruptGenerate();
          }
        }
      }
    } catch (err) {
      // Not when `stopped` -- interruptGenerate() above is the normal, frequent way a reply ends
      // once enough sentences are kept (every turn that hits maxSentences before the model stops
      // on its own), not a failure; draining after an intentional interrupt occasionally throws a
      // benign abort-style error, which must never get treated as the GPU/engine having died.
      if (!stopped) failed(err);
      throw err;
    }
    return { text: sent, raw, finishReason: stopped ? "stopped" : finishReason };
  }

  return { init, start, onChange, isReady, streamChat, getStatus: () => status };
})();
