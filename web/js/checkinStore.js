/**
 * Self-reported check-ins, backed by the local SQLite database (db.js).
 * This is the raw data a future ML/pattern-recognition feature would train
 * on, so keep the shape stable:
 *
 *   { id, timestamp (ISO string), type: 'resisted' | 'slipped', tags: string[], notes }
 *
 * Everything stays on-device — nothing is sent anywhere. Callers must wait
 * for DB.init() to resolve (done once, at app startup) before using this.
 */
const CheckInStore = (function () {
  function parseRow(row) {
    return { ...row, tags: row.tags ? JSON.parse(row.tags) : [] };
  }

  function list() {
    const rows = DB.all("SELECT * FROM checkins ORDER BY timestamp DESC");
    return rows.map(parseRow);
  }

  function add(entry) {
    const record = {
      id: `checkin_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: entry.timestamp,
      type: entry.type,
      tags: entry.tags || [],
      notes: entry.notes || "",
    };
    DB.run("INSERT INTO checkins (id, timestamp, type, tags, notes) VALUES (?, ?, ?, ?, ?)", [
      record.id,
      record.timestamp,
      record.type,
      JSON.stringify(record.tags),
      record.notes,
    ]);
    DB.scheduleSave();
    return record;
  }

  function remove(id) {
    DB.run("DELETE FROM checkins WHERE id = ?", [id]);
    DB.scheduleSave();
  }

  function clear() {
    DB.run("DELETE FROM checkins");
    DB.scheduleSave();
  }

  function exportJson() {
    return JSON.stringify(list(), null, 2);
  }

  return { list, add, remove, clear, exportJson };
})();
