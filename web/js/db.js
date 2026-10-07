/**
 * Local SQLite database for Reclaim, running entirely client-side via
 * sql.js (SQLite compiled to WebAssembly). Same code path on desktop
 * (Electron renderer) and Android (Capacitor WebView) and in a plain
 * browser — no native bindings, no server.
 *
 * Persistence: the whole database is a byte array. After each write we
 * serialize it and store it as base64 in localStorage. That's plenty for
 * this app's scale (a bundled resource library + one user's check-in
 * history) and keeps everything on-device.
 */
const DB = (function () {
  const STORAGE_KEY = "reclaim_sqlite_db_v1";

  const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS resources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      subtitle TEXT,
      body TEXT,
      url TEXT,
      contact TEXT,
      area TEXT,
      duration_min INTEGER,
      tags TEXT,
      method TEXT,
      is_sample INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bible_plan_days (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
      day_number INTEGER NOT NULL,
      reference TEXT NOT NULL,
      reflection TEXT
    );

    CREATE TABLE IF NOT EXISTS checkins (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      type TEXT NOT NULL,
      tags TEXT,
      notes TEXT,
      mood_rating INTEGER,
      urge_intensity INTEGER,
      sleep_hours REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    -- Singleton row (id always 1) -- one person's own setup answers, not a log of events like
    -- checkins. See PURPOSE.md: this is the structured source the AI's per-turn context is built
    -- from (personalContext.js), not a separate flat file to keep in sync by hand.
    CREATE TABLE IF NOT EXISTS user_preferences (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      accountability_name TEXT,
      accountability_phone TEXT,
      accountability_name_2 TEXT,
      accountability_phone_2 TEXT,
      pastor_name TEXT,
      pastor_phone TEXT,
      tempting_times TEXT,
      common_triggers TEXT,
      tempting_locations TEXT,
      notification_intensity TEXT NOT NULL DEFAULT 'medium',
      other_notes TEXT,
      onboarding_completed_at TEXT,
      updated_at TEXT,
      home_lat REAL,
      home_lon REAL,
      gender TEXT,
      preferred_coping_methods TEXT
    );

    -- One row per topic from bible_verses_for_100_circumstances.csv (user-provided). refs is a
    -- semicolon-separated list of real verse references, resolved live through YouVersion by
    -- reference rather than storing body text here -- see agentTools.js matchVerseTopic.
    CREATE TABLE IF NOT EXISTS verse_topics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic TEXT NOT NULL,
      refs TEXT NOT NULL
    );

    -- One row per thumbs up/down on a resource card in Chat (on-device AI mode only; Basic mode
    -- has no thumbs). Learning reads tool + keywords only, never the specific item -- the team
    -- decided preferences are about kinds of resources and themes, not individual cards (see
    -- resourceFeedback.js). resource_key is kept so a card can undo its own rating. Never leaves
    -- the device.
    CREATE TABLE IF NOT EXISTS resource_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      rating INTEGER NOT NULL CHECK (rating IN (-1, 1)),
      tool TEXT NOT NULL,
      resource_key TEXT,
      keywords TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_resources_type ON resources(type);
    CREATE INDEX IF NOT EXISTS idx_checkins_timestamp ON checkins(timestamp);
  `;

  // Bump whenever SEED_RESOURCES/SEED_BIBLE_PLANS/SEED_VERSE_TOPICS content changes materially.
  // ensureSeeded() re-syncs placeholder (is_sample=1) content up to this
  // version without ever touching checkins or user-added (is_sample=0) rows.
  const CURRENT_SEED_VERSION = 10;

  let sqlJs = null;
  let db = null;
  let ready = null;
  let saveTimer = null;

  function locateFile(file) {
    return "js/vendor/" + file;
  }

  function loadPersisted() {
    try {
      const b64 = localStorage.getItem(STORAGE_KEY);
      if (!b64) return null;
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    } catch (e) {
      return null;
    }
  }

  function persistNow() {
    try {
      const bytes = db.export();
      let binary = "";
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
      }
      localStorage.setItem(STORAGE_KEY, btoa(binary));
    } catch (e) {
      /* storage unavailable — changes are lost on reload, not fatal */
    }
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persistNow, 250);
  }

  function getMeta(key) {
    const row = get("SELECT value FROM app_meta WHERE key = ?", [key]);
    return row ? row.value : null;
  }

  // INSERT OR REPLACE, not a separate getMeta-then-INSERT-or-UPDATE check: the old check-then-
  // branch had a real race window (two calls for the same key close together could both see "no
  // row yet" and both attempt INSERT, the second failing on the key's UNIQUE constraint) --
  // confirmed via usageAnalytics.js's own test calls. This is atomic and has the same net effect
  // either way (row exists with this value), so nothing else needed to change.
  function setMeta(key, value) {
    run("INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)", [key, value]);
  }

  function ensureSeeded() {
    const version = parseInt(getMeta("seed_version") || "0", 10);
    if (version >= CURRENT_SEED_VERSION) return;

    run("BEGIN");
    try {
      const oldSamplePlanIds = all("SELECT id FROM resources WHERE type = 'bible_plan' AND is_sample = 1").map((r) => r.id);
      if (oldSamplePlanIds.length) {
        run(`DELETE FROM bible_plan_days WHERE plan_id IN (${oldSamplePlanIds.map(() => "?").join(",")})`, oldSamplePlanIds);
      }
      run("DELETE FROM resources WHERE is_sample = 1");

      for (const r of SEED_RESOURCES) {
        insertResource(r);
      }
      for (const plan of SEED_BIBLE_PLANS) {
        const planId = insertResource(plan.resource);
        for (const day of plan.days) {
          run(
            "INSERT INTO bible_plan_days (plan_id, day_number, reference, reflection) VALUES (?, ?, ?, ?)",
            [planId, day.day_number, day.reference, day.reflection]
          );
        }
      }

      run("DELETE FROM verse_topics");
      for (const vt of SEED_VERSE_TOPICS) {
        run("INSERT INTO verse_topics (topic, refs) VALUES (?, ?)", [vt.topic, vt.refs]);
      }
      run("COMMIT");
    } catch (e) {
      run("ROLLBACK");
      throw e;
    }
    setMeta("seed_version", String(CURRENT_SEED_VERSION));
    persistNow();
  }

  function insertResource(r) {
    run(
      `INSERT INTO resources (type, title, subtitle, body, url, contact, area, duration_min, tags, method, is_sample)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        r.type,
        r.title,
        r.subtitle ?? null,
        r.body ?? null,
        r.url ?? null,
        r.contact ?? null,
        r.area ?? null,
        r.duration_min ?? null,
        r.tags ? JSON.stringify(r.tags) : null,
        r.method ?? null,
        r.is_sample === 0 ? 0 : 1,
      ]
    );
    return lastInsertId();
  }

  function lastInsertId() {
    const row = get("SELECT last_insert_rowid() AS id");
    return row.id;
  }

  function run(sql, params) {
    db.run(sql, params || []);
  }

  function all(sql, params) {
    const stmt = db.prepare(sql);
    try {
      if (params) stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  function get(sql, params) {
    const rows = all(sql, params);
    return rows.length ? rows[0] : null;
  }

  function migrateColumns() {
    const checkinCols = all("PRAGMA table_info(checkins)").map((c) => c.name);
    if (!checkinCols.includes("mood_rating")) run("ALTER TABLE checkins ADD COLUMN mood_rating INTEGER");
    if (!checkinCols.includes("urge_intensity")) run("ALTER TABLE checkins ADD COLUMN urge_intensity INTEGER");
    // sleep_hours: kept for any existing installs that already logged it, but the check-in form no
    // longer collects it (superseded by the condition tags above, which already cover "what was
    // going on" -- a second sleep-specific field wasn't adding anything the tags didn't).
    if (!checkinCols.includes("sleep_hours")) run("ALTER TABLE checkins ADD COLUMN sleep_hours REAL");

    const prefCols = all("PRAGMA table_info(user_preferences)").map((c) => c.name);
    if (!prefCols.includes("home_lat")) run("ALTER TABLE user_preferences ADD COLUMN home_lat REAL");
    if (!prefCols.includes("home_lon")) run("ALTER TABLE user_preferences ADD COLUMN home_lon REAL");
    // Second accountability partner -- up to 2 is now supported everywhere the first one is.
    if (!prefCols.includes("accountability_name_2")) run("ALTER TABLE user_preferences ADD COLUMN accountability_name_2 TEXT");
    if (!prefCols.includes("accountability_phone_2")) run("ALTER TABLE user_preferences ADD COLUMN accountability_phone_2 TEXT");
    if (!prefCols.includes("gender")) run("ALTER TABLE user_preferences ADD COLUMN gender TEXT");
    if (!prefCols.includes("preferred_coping_methods")) run("ALTER TABLE user_preferences ADD COLUMN preferred_coping_methods TEXT");

    const resourceCols = all("PRAGMA table_info(resources)").map((c) => c.name);
    if (!resourceCols.includes("method")) run("ALTER TABLE resources ADD COLUMN method TEXT");
  }

  async function init() {
    if (ready) return ready;
    ready = (async () => {
      sqlJs = await initSqlJs({ locateFile });
      const existing = loadPersisted();
      db = existing ? new sqlJs.Database(existing) : new sqlJs.Database();
      db.exec(SCHEMA_SQL); // exec (not run) — run only executes the first statement of a multi-statement string
      migrateColumns();
      ensureSeeded();
    })();
    return ready;
  }

  return { init, run, all, get, insertResource, scheduleSave, persistNow, getMeta, setMeta };
})();
