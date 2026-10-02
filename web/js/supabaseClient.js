// Minimal fetch-based Supabase REST client -- no SDK, matching this project's "no build step, plain
// <script> tags" rule (same reasoning as reclaim-beta's SupabaseClient.java, but for the browser).
// Mostly read-only: the resource library is public data (RLS grants anon select only). The one
// exception is logAppOpen, which can only ever INSERT one anonymous row (see usageAnalytics.js and
// PURPOSE.md) -- RLS has no select/update/delete policy for anon on that table at all, so this key
// being public (same as it already was) can never be used to read usage data back, only add to it.
const SupabaseClient = (function () {
  const SUPABASE_URL = "https://hdymcreqtwcwgwftglox.supabase.co";
  const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_-DsHhVDv07sLfa_8YovrkA_nh_P9y1C";

  // filters: { column: value } becomes ?column=eq.value; value can be an array for column=in.(a,b).
  async function queryResources(type, filters = {}, { limit } = {}) {
    const params = new URLSearchParams({ select: "*", type: `eq.${type}` });
    for (const [col, val] of Object.entries(filters)) {
      params.set(col, Array.isArray(val) ? `in.(${val.join(",")})` : `eq.${val}`);
    }
    if (limit) params.set("limit", String(limit));
    const res = await fetch(`${SUPABASE_URL}/rest/v1/resources?${params}`, {
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}` },
    });
    if (!res.ok) throw new Error(`Supabase query failed: ${res.status}`);
    return res.json();
  }

  // One row per install per calendar day -- a unique constraint on (install_id, opened_date)
  // backs this, so a duplicate same-day ping (409, Postgres code 23505) is expected and treated
  // as success, not an error. Deliberately plain INSERT, not Prefer: resolution=ignore-duplicates
  // -- PostgREST's upsert path needs more than INSERT privilege to resolve conflicts, and granting
  // anon anything beyond INSERT on this table (e.g. SELECT) would mean the public key could be
  // used to read usage data back, defeating the entire point of this table's RLS design (see
  // PURPOSE.md). installId/openedDate are both already non-identifying (see usageAnalytics.js);
  // nothing else is ever sent.
  async function logAppOpen(installId, openedDate) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/app_opens`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ install_id: installId, opened_date: openedDate }),
    });
    if (!res.ok && res.status !== 409) throw new Error(`Supabase insert failed: ${res.status}`);
  }

  return { queryResources, logAppOpen };
})();
