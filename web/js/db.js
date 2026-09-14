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
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_resources_type ON resources(type);
    CREATE INDEX IF NOT EXISTS idx_checkins_timestamp ON checkins(timestamp);
  `;

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

  function seedIfEmpty() {
    const countRow = get("SELECT COUNT(*) AS n FROM resources");
    if (countRow && countRow.n > 0) return;

    run("BEGIN");
    try {
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
      run("COMMIT");
    } catch (e) {
      run("ROLLBACK");
      throw e;
    }
    persistNow();
  }

  function insertResource(r) {
    run(
      `INSERT INTO resources (type, title, subtitle, body, url, contact, area, duration_min, tags, is_sample)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

  async function init() {
    if (ready) return ready;
    ready = (async () => {
      sqlJs = await initSqlJs({ locateFile });
      const existing = loadPersisted();
      db = existing ? new sqlJs.Database(existing) : new sqlJs.Database();
      db.run(SCHEMA_SQL);
      seedIfEmpty();
    })();
    return ready;
  }

  return { init, run, all, get, insertResource, scheduleSave, persistNow };
})();
