/**
 * Minimal, privacy-preserving usage counter -- answers "how many people use Reclaim and how
 * often," nothing more. Deliberately not Firebase Analytics or any Google/ad-tech SDK: for an app
 * about pornography-addiction recovery, sending behavioral data to a third party is a real
 * privacy cost, not a neutral technical choice -- see PURPOSE.md's on-device-only commitment,
 * which this is built to stay inside the spirit of.
 *
 * What gets sent, in full: a random per-install UUID (installId below) and today's date, once per
 * calendar day, to Supabase's app_opens table (same project the public resource library already
 * reads from). Nothing else -- no device info, no behavior, no content, no location, no account.
 * installId is generated once on this device and never tied to anything identifying; there is no
 * way to go from it back to a person. The anon key this uses can only ever INSERT a row (see
 * supabaseClient.js/PURPOSE.md for the RLS policy) -- it can't read usage data back, so even if
 * this public key were extracted from the app, it couldn't be used to see who's using Reclaim.
 *
 * This answers "how many" (distinct install_ids) and "how often" (opens per install_id over time)
 * by querying app_opens directly in Supabase -- there's no in-app dashboard for it, this is a
 * backend-only counter for the person running the project, not a feature end users see.
 */
const UsageAnalytics = (function () {
  const INSTALL_ID_KEY = "analytics_install_id";
  const LAST_PING_KEY = "analytics_last_ping_date";

  function getOrCreateInstallId() {
    let id = DB.getMeta(INSTALL_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      DB.setMeta(INSTALL_ID_KEY, id);
    }
    return id;
  }

  // Fire-and-forget, called once at boot -- never blocks or fails the rest of app startup if
  // Supabase is unreachable. Skips the network call entirely once this device has already pinged
  // for today's date, so a day of normal use doesn't produce more than one row.
  async function pingIfNeeded() {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, local calendar day is fine -- this is a rough frequency counter, not a precise log
    if (DB.getMeta(LAST_PING_KEY) === today) return;
    try {
      const installId = getOrCreateInstallId();
      await SupabaseClient.logAppOpen(installId, today);
      DB.setMeta(LAST_PING_KEY, today);
    } catch (e) {
      console.warn("Usage ping failed (non-fatal):", e);
    }
  }

  return { pingIfNeeded };
})();
