package com.reclaim.app;

import android.content.Context;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Small shared bookkeeping for both notification types (nightly check-in, risk nudge): how many
 * were sent vs. actually responded to, and whether the MOST RECENT one of each type went
 * unanswered -- which is what drives escalating the next one to setFullScreenIntent (see
 * NightlyCheckinWorker; RiskNudgeMonitor already always uses it, so there's nothing further for
 * that type to escalate to -- this still tracks its stats for the same reason).
 *
 * "Responded" means any action tap or opening the app from the notification at all -- not a
 * judgment about whether it was a "real" response, just whether the person engaged with it before
 * it either got acted on or quietly timed out. One documented gap: the risk-nudge notification's
 * "Call" action can't be tracked here without breaking it -- see RiskNudgeMonitor's own comment on
 * why that one has to stay a direct, unwrapped PendingIntent.
 *
 * Deliberately separate from RiskScorer's adaptive-tuning app_meta keys -- this is bookkeeping
 * about the notifications themselves, not a scoring input.
 */
final class NotificationTracking {
    private NotificationTracking() {}

    static final String TYPE_NIGHTLY = "nightly";
    static final String TYPE_RISK = "risk";

    private static final String META_KEY_STATS = "notification_stats";
    private static final String META_KEY_LAST_ANSWERED_PREFIX = "last_answered_";

    // Called right before posting a notification of this type. Returns true if THIS occurrence
    // should escalate -- i.e. the previous one of the same type was left unanswered. Either way,
    // records a new "sent" and resets this occurrence's answered flag to false (pending) so a
    // later, still-unanswered one knows to escalate in turn.
    static boolean recordSentAndShouldEscalate(Context ctx, String type) {
        LocalSignalsDb db = LocalSignalsDb.getInstance(ctx);
        // null (nothing of this type ever sent before) never escalates -- there's no prior
        // occurrence to have gone unanswered.
        boolean escalate = "false".equals(db.getMeta(META_KEY_LAST_ANSWERED_PREFIX + type));
        bumpStat(db, type, "sent");
        db.setMeta(META_KEY_LAST_ANSWERED_PREFIX + type, "false");
        return escalate;
    }

    // Called the moment any action/body tap for a notification of this type is handled.
    // Idempotent per occurrence: a single notification instance can trigger this more than once
    // in practice -- confirmed on-device, not theoretical -- e.g. its full-screen intent
    // auto-fires from idle detection, then it's also tapped for real afterward, since a system
    // auto-launch doesn't go through the same tap-recognized auto-cancel path a real shade tap
    // does. Only the first call for a given occurrence counts; later ones are no-ops.
    static void recordResponded(Context ctx, String type) {
        LocalSignalsDb db = LocalSignalsDb.getInstance(ctx);
        if ("true".equals(db.getMeta(META_KEY_LAST_ANSWERED_PREFIX + type))) return;
        bumpStat(db, type, "responded");
        db.setMeta(META_KEY_LAST_ANSWERED_PREFIX + type, "true");
    }

    private static void bumpStat(LocalSignalsDb db, String type, String field) {
        JSONObject stats = loadStats(db);
        try {
            JSONObject forType = stats.optJSONObject(type);
            if (forType == null) {
                forType = new JSONObject();
                stats.put(type, forType);
            }
            forType.put(field, forType.optInt(field, 0) + 1);
        } catch (JSONException e) {
            return; // shouldn't happen (plain ints/objects), but don't half-write on a failure
        }
        db.setMeta(META_KEY_STATS, stats.toString());
    }

    private static JSONObject loadStats(LocalSignalsDb db) {
        String json = db.getMeta(META_KEY_STATS);
        if (json != null && !json.isEmpty()) {
            try {
                return new JSONObject(json);
            } catch (JSONException e) {
                // Malformed -- start fresh rather than fail the whole call.
            }
        }
        return new JSONObject();
    }

    // Read-only accessor for LocalSignalsPlugin.getNotificationStats -- always valid JSON (an
    // empty object if nothing's been recorded yet), never null, so JS never has to guard for it.
    static String statsJson(Context ctx) {
        String json = LocalSignalsDb.getInstance(ctx).getMeta(META_KEY_STATS);
        return json != null && !json.isEmpty() ? json : "{}";
    }
}
