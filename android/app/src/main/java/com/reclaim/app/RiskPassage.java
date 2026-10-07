package com.reclaim.app;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Calendar;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Set;

/**
 * Picks which daily passage a risk nudge offers to pray through ("Pray through Romans 8:31-39" on the
 * full-screen check-in, RiskOverlay, and on the fallback notification), from the plan the app's on-device AI
 * built while it was open (PassageBank in web/js/passageBank.js, synced into app_meta "passage_plan"). The
 * button opens the app into the Lectio Divina meditation on it (web/js/lectioView.js). Replaced RiskVerse,
 * the short AI-picked verse that used to be on the overlay (Nathaniel, 2026-10-07).
 *
 * The rule: the first nudge of the day offers TODAY's passage (the same one Home shows); later nudges offer
 * the passage the AI ranked best for this situation (which reasons fired, what time of day) -- never one
 * already offered or prayed through today. With no ranking (the embedding model isn't downloaded) the
 * person's upcoming daily passages are used instead, in order. Port of extension/lib/passagePicker.js --
 * keep the two in step.
 */
final class RiskPassage {
    private RiskPassage() {}

    static final class Passage {
        final String ref, description;
        final boolean today; // today's daily passage, not a situation pick
        Passage(String ref, String description, boolean today) {
            this.ref = ref;
            this.description = description;
            this.today = today;
        }
    }

    private static final String META_PLAN = "passage_plan";
    private static final String META_USED = "passages_used"; // {"day": n, "refs": [...]} -- offered today

    /** "<signature>|<time bucket>", with "K" for anything without an app/duration clause (e.g. a keyword nudge). */
    static String keyFor(String signature, String bucket) {
        return (signature == null ? "K" : signature) + "|" + (bucket == null ? "" : bucket);
    }

    /** Local calendar day as a whole number -- the same number DailyPassage.dayNumber computes in the app. */
    static long today() {
        Calendar c = Calendar.getInstance();
        long localMs = c.getTimeInMillis() + c.get(Calendar.ZONE_OFFSET) + c.get(Calendar.DST_OFFSET);
        return (long) Math.floor(localMs / 86400000.0);
    }

    /** The passage for this nudge, recorded as offered today; null if the app hasn't synced a plan yet. */
    static Passage pick(LocalSignalsDb db, String key) {
        long day = today();
        List<String> usedToday = usedOn(db.getMeta(META_USED), day);
        Passage p = choose(db.getMeta(META_PLAN), new HashSet<>(usedToday), key, day);
        if (p != null) {
            usedToday.add(p.ref);
            try {
                JSONObject u = new JSONObject();
                u.put("day", day);
                u.put("refs", new JSONArray(usedToday));
                db.setMeta(META_USED, u.toString());
            } catch (JSONException e) {
                // Not recorded: a later nudge today might offer it again -- better than no passage.
            }
        }
        return p;
    }

    private static List<String> usedOn(String raw, long day) {
        List<String> out = new ArrayList<>();
        if (raw == null || raw.isEmpty()) return out;
        try {
            JSONObject u = new JSONObject(raw);
            if (u.optLong("day", -1) != day) return out;
            JSONArray refs = u.optJSONArray("refs");
            for (int i = 0; refs != null && i < refs.length(); i++) out.add(refs.optString(i));
        } catch (JSONException e) {
            // malformed -- treat as nothing offered yet today
        }
        return out;
    }

    // The pure part (no Android): `rawPlan` is the synced JSON, `used` what was already offered today.
    static Passage choose(String rawPlan, Set<String> used, String key, long day) {
        if (rawPlan == null || rawPlan.isEmpty()) return null;
        JSONObject plan;
        try {
            plan = new JSONObject(rawPlan);
        } catch (JSONException e) {
            return null; // malformed plan: no passage rather than fail the check-in
        }
        JSONObject passages = plan.optJSONObject("passages");
        if (passages == null) return null;
        Set<String> taken = new HashSet<>(used);
        JSONObject appUsed = plan.optJSONObject("used");
        if (appUsed != null && appUsed.optLong("day", -1) == day) {
            JSONArray refs = appUsed.optJSONArray("refs");
            for (int i = 0; refs != null && i < refs.length(); i++) taken.add(refs.optString(i));
        }

        JSONArray schedule = plan.optJSONArray("schedule");
        if (schedule == null) schedule = new JSONArray();
        for (int i = 0; i < schedule.length(); i++) {
            JSONObject s = schedule.optJSONObject(i);
            if (s != null && s.optLong("day", -1) == day) {
                String ref = s.optString("ref", null);
                if (ok(passages, taken, ref)) return passage(passages, ref, true);
                break;
            }
        }
        JSONObject ranked = plan.optJSONObject("ranked");
        JSONArray forKey = ranked != null ? ranked.optJSONArray(key) : null;
        for (int i = 0; forKey != null && i < forKey.length(); i++) {
            String ref = forKey.optString(i, null);
            if (ok(passages, taken, ref)) return passage(passages, ref, false);
        }
        for (int i = 0; i < schedule.length(); i++) {
            JSONObject s = schedule.optJSONObject(i);
            if (s == null || s.optLong("day", -1) <= day) continue;
            String ref = s.optString("ref", null);
            if (ok(passages, taken, ref)) return passage(passages, ref, false);
        }
        Iterator<String> all = passages.keys();
        while (all.hasNext()) {
            String ref = all.next();
            if (ok(passages, taken, ref)) return passage(passages, ref, false);
        }
        return null;
    }

    private static boolean ok(JSONObject passages, Set<String> taken, String ref) {
        return ref != null && !ref.trim().isEmpty() && passages.has(ref) && !taken.contains(ref);
    }

    private static Passage passage(JSONObject passages, String ref, boolean today) {
        return new Passage(ref, passages.optString(ref, "").trim(), today);
    }
}
