package com.reclaim.app;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Free-text feedback typed on the full-screen check-in's flag page (RiskOverlay), waiting for the
 * on-device AI. The overlay is native and the model only runs in the WebView, so the person's own
 * words are parked here (app_meta "pending_feedback_notes") and picked up by the app the next time
 * it opens -- RiskExplainer.processFeedbackNotes reads which part of the nudge the person said was
 * wrong, applies the weight change, and keeps the note as context for later.
 *
 * Each note: {alertId, app, text, factors (every factor that fired), applied, at}. `applied` is true
 * when the weights were already adjusted at tap time (they picked specific reasons, or just skipped),
 * in which case the AI only keeps the note as context and must NOT adjust again; false means the
 * person typed words without picking reasons, so deciding which factors they meant is the AI's job.
 *
 * If the app is never opened, unapplied notes can't wait forever: flushStale applies them to every
 * factor that fired after STALE_MS (the person did flag it as wrong; only the "which part" is
 * unknown), from the same background worker that posts nudges.
 */
final class RiskFeedbackNotes {
    private static final String KEY = "pending_feedback_notes";
    private static final long STALE_MS = 12L * 60 * 60 * 1000;
    private static final int MAX_NOTES = 20;
    private static final int MAX_TEXT = 400;

    private RiskFeedbackNotes() {}

    private static JSONArray load(LocalSignalsDb db) {
        String raw = db.getMeta(KEY);
        if (raw == null || raw.isEmpty()) return new JSONArray();
        try {
            return new JSONArray(raw);
        } catch (JSONException e) {
            return new JSONArray(); // malformed -- start clean rather than fail a feedback tap
        }
    }

    static synchronized void add(Context ctx, long alertId, String app, String text, JSONArray firedFactors, boolean applied) {
        LocalSignalsDb db = LocalSignalsDb.getInstance(ctx);
        JSONArray all = load(db);
        try {
            JSONObject note = new JSONObject();
            note.put("alertId", alertId);
            note.put("app", app == null ? "" : app);
            note.put("text", text.length() > MAX_TEXT ? text.substring(0, MAX_TEXT) : text);
            note.put("factors", firedFactors == null ? new JSONArray() : firedFactors);
            note.put("applied", applied);
            note.put("at", System.currentTimeMillis());
            all.put(note);
        } catch (JSONException e) {
            return;
        }
        // Keep the newest MAX_NOTES.
        JSONArray kept = new JSONArray();
        for (int i = Math.max(0, all.length() - MAX_NOTES); i < all.length(); i++) kept.put(all.opt(i));
        db.setMeta(KEY, kept.toString());
    }

    // Everything waiting, cleared on read -- the app handles each note exactly once.
    static synchronized JSONArray takeAll(Context ctx) {
        LocalSignalsDb db = LocalSignalsDb.getInstance(ctx);
        JSONArray all = load(db);
        db.setMeta(KEY, "");
        return all;
    }

    // Unapplied notes the app never got to: apply them to every factor that fired (idempotent per
    // alert id, so it can't double-count if the app handled one in the meantime), then drop them.
    static synchronized void flushStale(Context ctx) {
        LocalSignalsDb db = LocalSignalsDb.getInstance(ctx);
        JSONArray all = load(db);
        if (all.length() == 0) return;
        JSONArray remaining = new JSONArray();
        long now = System.currentTimeMillis();
        boolean changed = false;
        for (int i = 0; i < all.length(); i++) {
            JSONObject n = all.optJSONObject(i);
            if (n == null) continue;
            boolean stale = !n.optBoolean("applied") && now - n.optLong("at", now) > STALE_MS;
            if (stale) {
                RiskScorer.applyFeedback(ctx, n.optLong("alertId"), n.optJSONArray("factors"), false);
                changed = true;
            } else {
                remaining.put(n);
            }
        }
        if (changed) db.setMeta(KEY, remaining.length() == 0 ? "" : remaining.toString());
    }
}
