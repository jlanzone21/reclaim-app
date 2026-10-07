package com.reclaim.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Random;

/**
 * Picks the Bible verse shown on the full-screen check-in (RiskOverlay) from the bank the app's
 * on-device AI built ahead of time (VerseBank in web/js/verseBank.js, synced into app_meta
 * "verse_bank"). The overlay is native and has no model, so the choosing already happened: for each
 * situation (the combination of reasons -- the same signature letters as RiskNotificationText -- at a
 * time of day) the bank holds the 3 best verses for THIS person, with their text and the translation's
 * required attribution. This only picks which of those to show.
 *
 * The first verse shown is never the one shown last time when there's another to choose; "Not for me"
 * on the overlay walks on to the next one in the list.
 */
final class RiskVerse {
    private RiskVerse() {}

    static final class Verse {
        final String ref, text, attribution;
        Verse(String ref, String text, String attribution) {
            this.ref = ref;
            this.text = text;
            this.attribution = attribution;
        }
    }

    private static final String META_BANK = "verse_bank";
    private static final String META_LAST = "last_verse_ref";
    private static final int MAX_TEXT = 360;

    /** "<signature>|<time bucket>", with "K" for anything without an app/duration clause (e.g. a keyword nudge). */
    static String keyFor(String signature, String bucket) {
        return (signature == null ? "K" : signature) + "|" + (bucket == null ? "" : bucket);
    }

    // A verse from the synced bank is only shown if it is still shaped like one.
    static boolean valid(String ref, String text) {
        return ref != null && !ref.trim().isEmpty() && text != null && text.trim().length() > 10 && text.length() <= MAX_TEXT;
    }

    /**
     * The verses for this situation in the order to show them (the first is what appears; "Not for me" walks
     * on). Empty if the bank has nothing for it yet.
     */
    static List<Verse> pick(LocalSignalsDb db, String key, Random rnd) {
        return choose(db.getMeta(META_BANK), db.getMeta(META_LAST), key, rnd);
    }

    // The pure part (no Android): `rawBank` is the synced JSON, `lastRef` the verse shown last time.
    static List<Verse> choose(String rawBank, String lastRef, String key, Random rnd) {
        List<Verse> all = new ArrayList<>();
        try {
            String raw = rawBank;
            if (raw == null || raw.isEmpty()) return all;
            JSONArray arr = new JSONObject(raw).optJSONArray(key);
            if (arr == null) return all;
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                String ref = o.optString("ref", null);
                String text = o.optString("text", null);
                if (valid(ref, text)) all.add(new Verse(ref.trim(), text.trim(), o.optString("attribution", "").trim()));
            }
        } catch (org.json.JSONException e) {
            return new ArrayList<>(); // malformed bank: show no verse rather than fail the check-in
        }
        if (all.size() < 2) return all;
        // Don't open with the verse shown last time; shuffle the rest, and keep that one as the last resort.
        String last = lastRef;
        List<Verse> fresh = new ArrayList<>();
        List<Verse> repeat = new ArrayList<>();
        for (Verse v : all) (v.ref.equals(last) ? repeat : fresh).add(v);
        Collections.shuffle(fresh, rnd);
        fresh.addAll(repeat);
        return fresh;
    }

    static void markShown(LocalSignalsDb db, String ref) {
        db.setMeta(META_LAST, ref);
    }
}
