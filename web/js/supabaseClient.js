// Minimal fetch-based Supabase REST client -- no SDK, matching this project's "no build step, plain
// <script> tags" rule (same reasoning as reclaim-beta's SupabaseClient.java, but for the browser).
// Read-only: the resource library is public data (RLS grants anon select only), so this never
// sends the key anywhere but Supabase's own REST endpoint, and never writes.
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

  return { queryResources };
})();
