/**
 * App settings — currently just the user's own Anthropic API key and model
 * choice. Stored in localStorage only, never sent anywhere but directly to
 * Anthropic's API from this device.
 */
const SettingsStore = (function () {
  const KEY_API_KEY = "reclaim_anthropic_api_key";
  const KEY_MODEL = "reclaim_anthropic_model";
  const DEFAULT_MODEL = "claude-sonnet-5";

  function getApiKey() {
    try {
      return localStorage.getItem(KEY_API_KEY) || "";
    } catch (e) {
      return "";
    }
  }

  function setApiKey(key) {
    try {
      if (key) localStorage.setItem(KEY_API_KEY, key.trim());
      else localStorage.removeItem(KEY_API_KEY);
    } catch (e) {}
  }

  function getModel() {
    try {
      return localStorage.getItem(KEY_MODEL) || DEFAULT_MODEL;
    } catch (e) {
      return DEFAULT_MODEL;
    }
  }

  function setModel(model) {
    try {
      localStorage.setItem(KEY_MODEL, model);
    } catch (e) {}
  }

  return { getApiKey, setApiKey, getModel, setModel, DEFAULT_MODEL };
})();
