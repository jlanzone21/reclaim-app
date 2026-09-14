/**
 * Query layer over the resources table (see db.js). Everything here is
 * synchronous — sql.js runs entirely in-memory/WASM, so once DB.init() has
 * resolved these calls don't touch disk or the network.
 */
const ResourceRepo = (function () {
  function parseRow(row) {
    if (!row) return null;
    return { ...row, tags: row.tags ? JSON.parse(row.tags) : [] };
  }

  function byType(type, limit) {
    const rows = DB.all(
      `SELECT * FROM resources WHERE type = ? ORDER BY id ${limit ? "LIMIT ?" : ""}`,
      limit ? [type, limit] : [type]
    );
    return rows.map(parseRow);
  }

  function randomByTheme(type, theme) {
    const rows = byType(type);
    if (theme) {
      const matches = rows.filter((r) => r.tags.includes(theme));
      if (matches.length) return matches[Math.floor(Math.random() * matches.length)];
    }
    return rows.length ? rows[Math.floor(Math.random() * rows.length)] : null;
  }

  function getScripture(theme) {
    return randomByTheme("scripture", theme);
  }

  function getSermons() {
    return byType("sermon");
  }

  function getArticles() {
    return byType("article");
  }

  function getDevotional(theme) {
    return randomByTheme("devotional", theme);
  }

  function getCopingMechanisms(theme) {
    const rows = byType("coping_mechanism");
    if (!theme) return rows;
    const matches = rows.filter((r) => r.tags.includes(theme));
    return matches.length ? matches : rows;
  }

  function getBiblePlans() {
    const plans = byType("bible_plan");
    return plans.map((plan) => {
      const days = DB.all(
        "SELECT day_number, reference, reflection FROM bible_plan_days WHERE plan_id = ? ORDER BY day_number",
        [plan.id]
      );
      return { ...plan, days };
    });
  }

  function getSmallGroups() {
    return byType("small_group");
  }

  function getAccountabilityPrograms() {
    return byType("accountability_program");
  }

  function getCounselingCenters() {
    return byType("counseling_center");
  }

  return {
    getScripture,
    getSermons,
    getArticles,
    getDevotional,
    getCopingMechanisms,
    getBiblePlans,
    getSmallGroups,
    getAccountabilityPrograms,
    getCounselingCenters,
  };
})();
