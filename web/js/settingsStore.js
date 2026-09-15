/**
 * App settings — which AI provider is active, and a separate API key +
 * model choice per provider (so switching providers doesn't lose a
 * previously entered key). Stored in localStorage only, never sent
 * anywhere but directly to that provider's own API from this device.
 */
const SettingsStore = (function () {
  const KEY_PROVIDER = "reclaim_agent_provider";

  const PROVIDERS = {
    anthropic: {
      label: "Anthropic (Claude)",
      defaultModel: "claude-sonnet-5",
      models: [
        { value: "claude-sonnet-5", label: "Claude Sonnet 5 (recommended)" },
        { value: "claude-haiku-4-5", label: "Claude Haiku 4.5 (faster, cheaper)" },
        { value: "claude-opus-5", label: "Claude Opus 5 (most capable)" },
      ],
      keyPlaceholder: "sk-ant-...",
    },
    gemini: {
      label: "Google (Gemini)",
      defaultModel: "gemini-3.5-flash",
      models: [
        { value: "gemini-3.5-flash", label: "Gemini 3.5 Flash (recommended)" },
        { value: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite (faster, cheaper)" },
        { value: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (most capable)" },
      ],
      keyPlaceholder: "AIza...",
    },
  };

  function keyStorageKey(provider) {
    return `reclaim_api_key_${provider}`;
  }

  function modelStorageKey(provider) {
    return `reclaim_model_${provider}`;
  }

  function getProvider() {
    try {
      const p = localStorage.getItem(KEY_PROVIDER);
      return PROVIDERS[p] ? p : "anthropic";
    } catch (e) {
      return "anthropic";
    }
  }

  function setProvider(provider) {
    try {
      if (PROVIDERS[provider]) localStorage.setItem(KEY_PROVIDER, provider);
    } catch (e) {}
  }

  function getApiKey(provider) {
    provider = provider || getProvider();
    try {
      return localStorage.getItem(keyStorageKey(provider)) || "";
    } catch (e) {
      return "";
    }
  }

  function setApiKey(provider, key) {
    try {
      if (key) localStorage.setItem(keyStorageKey(provider), key.trim());
      else localStorage.removeItem(keyStorageKey(provider));
    } catch (e) {}
  }

  function getModel(provider) {
    provider = provider || getProvider();
    try {
      return localStorage.getItem(modelStorageKey(provider)) || PROVIDERS[provider].defaultModel;
    } catch (e) {
      return PROVIDERS[provider].defaultModel;
    }
  }

  function setModel(provider, model) {
    try {
      localStorage.setItem(modelStorageKey(provider), model);
    } catch (e) {}
  }

  /** Is there an active, usable key for the currently selected provider? */
  function isConnected() {
    return !!getApiKey(getProvider());
  }

  return { PROVIDERS, getProvider, setProvider, getApiKey, setApiKey, getModel, setModel, isConnected };
})();
