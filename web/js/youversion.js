/**
 * Bible text from the YouVersion Platform (https://developers.youversion.com), rendered the way
 * their SDK expects: YouVersion's transformed passage HTML inside a data-slot="yv-bible-renderer"
 * container, their Bible stylesheets, and the version's copyright attribution -- which the license
 * requires be shown every time the text is. Used by the Home "Today's Verse" card (YouVersion's own
 * Verse of the Day -- Home only; Chat never repeats it) and by Chat whenever someone asks for a
 * verse (app.js renderToolResult).
 *
 * The SDK itself (@youversion/platform-core) is vendored as a plain script at
 * js/vendor/youversion-platform.js -- see scripts/vendor-youversion.mjs -- matching this project's
 * "no build step, plain <script> tags" rule.
 *
 * Everything here fails soft: with no app key, no network, or an API error, callers get null and
 * fall back to the local seeded verse text (ResourceRepo.getScripture), so a verse card is never
 * left empty.
 */
const YouVersion = (function () {
  // Free App Key from https://platform.youversion.com. Like the Supabase publishable key it ships in
  // the client by design -- it identifies the app to YouVersion, it isn't a secret.
  const APP_KEY = "zAGTTUfjIl45Yn8P0xiamAN34XZ8Ei3t6sdAFbzdgBFjkV3m";

  // Tried in order; the first one this app key is licensed for wins (checked once, then cached).
  // 111 = NIV, the translation the team wants (licensed for this key via Biblica). 3034 = Berean
  // Standard Bible (BSB) is only a fallback, used if NIV access is ever revoked (YouVersion answers
  // 403 for an unlicensed version).
  const VERSION_IDS = [111, 3034];

  // English book name (as written in seedData.js titles) -> USFM book code YouVersion expects.
  const BOOKS = [
    ["Genesis", "GEN"], ["Exodus", "EXO"], ["Leviticus", "LEV"], ["Numbers", "NUM"], ["Deuteronomy", "DEU"],
    ["Joshua", "JOS"], ["Judges", "JDG"], ["Ruth", "RUT"], ["1 Samuel", "1SA"], ["2 Samuel", "2SA"],
    ["1 Kings", "1KI"], ["2 Kings", "2KI"], ["1 Chronicles", "1CH"], ["2 Chronicles", "2CH"], ["Ezra", "EZR"],
    ["Nehemiah", "NEH"], ["Esther", "EST"], ["Job", "JOB"], ["Psalm", "PSA"], ["Proverbs", "PRO"],
    ["Ecclesiastes", "ECC"], ["Song of Songs", "SNG"], ["Isaiah", "ISA"], ["Jeremiah", "JER"], ["Lamentations", "LAM"],
    ["Ezekiel", "EZK"], ["Daniel", "DAN"], ["Hosea", "HOS"], ["Joel", "JOL"], ["Amos", "AMO"],
    ["Obadiah", "OBA"], ["Jonah", "JON"], ["Micah", "MIC"], ["Nahum", "NAM"], ["Habakkuk", "HAB"],
    ["Zephaniah", "ZEP"], ["Haggai", "HAG"], ["Zechariah", "ZEC"], ["Malachi", "MAL"], ["Matthew", "MAT"],
    ["Mark", "MRK"], ["Luke", "LUK"], ["John", "JHN"], ["Acts", "ACT"], ["Romans", "ROM"],
    ["1 Corinthians", "1CO"], ["2 Corinthians", "2CO"], ["Galatians", "GAL"], ["Ephesians", "EPH"], ["Philippians", "PHP"],
    ["Colossians", "COL"], ["1 Thessalonians", "1TH"], ["2 Thessalonians", "2TH"], ["1 Timothy", "1TI"], ["2 Timothy", "2TI"],
    ["Titus", "TIT"], ["Philemon", "PHM"], ["Hebrews", "HEB"], ["James", "JAS"], ["1 Peter", "1PE"],
    ["2 Peter", "2PE"], ["1 John", "1JN"], ["2 John", "2JN"], ["3 John", "3JN"], ["Jude", "JUD"],
    ["Revelation", "REV"],
  ];
  const NAME_TO_USFM = new Map(BOOKS.map(([name, code]) => [name.toLowerCase(), code]));
  NAME_TO_USFM.set("psalms", "PSA");
  NAME_TO_USFM.set("song of solomon", "SNG");
  const USFM_TO_NAME = new Map(BOOKS.map(([name, code]) => [code, name]));

  let bibleClient = null;
  let versionIdPromise = null;
  const cache = new Map(); // passageId -> Promise<display|null>, so a re-render never refetches
  const loadedStylesheets = new Set();

  function available() {
    return Boolean(APP_KEY) && typeof YouVersionPlatform !== "undefined";
  }

  function client() {
    if (!bibleClient) {
      bibleClient = new YouVersionPlatform.BibleClient(new YouVersionPlatform.ApiClient({ appKey: APP_KEY }));
    }
    return bibleClient;
  }

  // Day-of-year in the user's local time zone (Jan 1 = 1), which is what YouVersion's Verse of the
  // Day calendar is keyed on -- so "today's verse" flips at the user's midnight, not UTC's.
  function dayOfYear(date = new Date()) {
    const start = Date.UTC(date.getFullYear(), 0, 1);
    const today = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
    return Math.floor((today - start) / 86400000) + 1;
  }

  // "Psalm 139:23-24" -> "PSA.139.23-24". null for anything it can't parse (caller falls back).
  function referenceToPassageId(reference) {
    const m = /^\s*(.+?)\s+(\d+)(?::(\d+)(?:\s*[-–]\s*(\d+))?)?\s*$/.exec(reference || "");
    if (!m) return null;
    const code = NAME_TO_USFM.get(m[1].toLowerCase());
    if (!code) return null;
    let id = `${code}.${m[2]}`;
    if (m[3]) id += `.${m[3]}`;
    if (m[4]) id += `-${m[4]}`;
    return id;
  }

  // "PSA.139.23-24" -> "Psalm 139:23-24". Also handles the long form "JHN.3.16-JHN.3.17".
  function passageIdToReference(passageId) {
    const [start, end] = String(passageId).split("-");
    const [code, chapter, verse] = start.split(".");
    const name = USFM_TO_NAME.get(code) || code;
    let ref = verse ? `${name} ${chapter}:${verse}` : `${name} ${chapter}`;
    if (end) ref += `-${end.split(".").pop()}`;
    return ref;
  }

  // First entry of VERSION_IDS this key can use. Only a definite "not licensed" moves on to the
  // next one; a network error isn't cached, so the next call tries again.
  function versionId() {
    if (!versionIdPromise) {
      versionIdPromise = (async () => {
        for (const id of VERSION_IDS.slice(0, -1)) {
          try {
            await client().getVersion(id);
            return id;
          } catch (err) {
            if (!/\b(401|403|404)\b|forbidden|not found/i.test(String(err && (err.status || err.message)))) throw err;
          }
        }
        return VERSION_IDS[VERSION_IDS.length - 1];
      })().catch((err) => {
        versionIdPromise = null;
        throw err;
      });
    }
    return versionIdPromise;
  }

  function fetchDisplay(passageId) {
    if (!cache.has(passageId)) {
      const p = versionId()
        .then((id) => client().getPassageDisplay({ versionId: id, passageId, includeHeadings: false, includeNotes: false }))
        .then((display) => ({ ...display, passageId, reference: passageIdToReference(passageId) }))
        .catch((err) => {
          console.warn("[YouVersion] passage fetch failed", passageId, err);
          cache.delete(passageId); // let a later attempt (e.g. back online) try again
          return null;
        });
      cache.set(passageId, p);
    }
    return cache.get(passageId);
  }

  // YouVersion's Verse of the Day for today. Resolves to a display object or null.
  async function getTodaysVerse() {
    if (!available()) return null;
    try {
      const votd = await client().getVOTD(dayOfYear());
      return votd && votd.passage_id ? fetchDisplay(votd.passage_id) : null;
    } catch (err) {
      console.warn("[YouVersion] verse of the day failed", err);
      return null;
    }
  }

  // A specific verse by its human reference (e.g. a themed pick from seedData.js).
  async function getVerse(reference) {
    if (!available()) return null;
    const passageId = referenceToPassageId(reference);
    return passageId ? fetchDisplay(passageId) : null;
  }

  function ensureStylesheets(display) {
    for (const sheet of display.stylesheets || []) {
      if (loadedStylesheets.has(sheet.href)) continue;
      loadedStylesheets.add(sheet.href);
      const link = document.createElement("link");
      link.rel = sheet.rel || "stylesheet";
      link.href = sheet.href;
      document.head.appendChild(link);
    }
  }

  // Builds the YouVersion verse block: passage HTML (inside the SDK's container attributes, which
  // the Bible stylesheet is scoped to), the reference, and the required copyright attribution.
  function render(display, { showReference = true } = {}) {
    ensureStylesheets(display);
    const wrap = document.createElement("div");
    wrap.className = "yv-verse";

    const text = document.createElement("div");
    text.className = "yv-verse-text";
    for (const [attr, value] of Object.entries(display.containerAttributes || { "data-yv-sdk": "", "data-slot": "yv-bible-renderer" })) {
      text.setAttribute(attr, value);
    }
    // Already sanitized/transformed by the SDK (getPassageDisplay) -- YouVersion's supported way
    // to render it.
    text.innerHTML = display.html;
    wrap.appendChild(text);

    if (showReference) {
      const ref = document.createElement("div");
      ref.className = "yv-verse-ref";
      const abbr = display.version && (display.version.localized_abbreviation || display.version.abbreviation);
      ref.textContent = abbr ? `${display.reference} · ${abbr}` : display.reference;
      wrap.appendChild(ref);
    }

    const attribution = document.createElement("div");
    attribution.className = "yv-verse-attribution";
    attribution.textContent = display.attribution ? display.attribution.text : "";
    const via = document.createElement("span");
    via.className = "yv-verse-via";
    via.textContent = " Provided by YouVersion.";
    attribution.appendChild(via);
    wrap.appendChild(attribution);

    return wrap;
  }

  return { available, getTodaysVerse, getVerse, render, referenceToPassageId, passageIdToReference, dayOfYear };
})();
