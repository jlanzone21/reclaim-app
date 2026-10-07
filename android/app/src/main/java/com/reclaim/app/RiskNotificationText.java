package com.reclaim.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Builds the risk-nudge notification text from what RiskScorer actually did (its trace), e.g.
 * "You've been on Instagram for 22 minutes. Let's check in." Port of extension/lib/
 * notificationText.js -- keep the two in step (same phrases, priority, caps).
 *
 * Where the wording comes from: the on-device AI (web/js/riskExplainer.js) writes several phrase
 * templates per factor while the app is open and syncs them here (app_meta "phrase_bank"); this
 * class only fills in the live values ({app}, {minutes}, {time}) when the background Worker posts a
 * notification, because the model can't run while the app is closed. With no bank yet (model not
 * downloaded, first run) the built-in phrases below are used, so a notification is never blank.
 *
 * Two exceptions, on purpose: the keyword factors always use a fixed built-in line -- never AI
 * wording and never the matched word or anything that was on screen -- so a model can't be talking
 * about explicit content on a lock screen; and when the user turns "lock-screen detail" off (a
 * Privacy setting, default ON) compose() returns null and the caller uses the generic wording.
 */
final class RiskNotificationText {
    private RiskNotificationText() {}

    private static final Map<String, String> TIME_WORDS = new HashMap<>();
    static {
        TIME_WORDS.put("Morning", "this morning");
        TIME_WORDS.put("Afternoon", "this afternoon");
        TIME_WORDS.put("Evening", "this evening");
        TIME_WORDS.put("Night", "late tonight");
    }

    // Highest priority first: what's most specific to what's happening right now leads.
    private static final String[] PRIORITY = {
            "recentKeywordSevere", "recentKeyword", "recentKeywordMild", "duration", "socialMedia",
            "triggerApp", "selfReportedTime", "historicalTime", "alone"};
    private static final Set<String> KEYWORD_FACTORS = new HashSet<>(
            Arrays.asList("recentKeywordSevere", "recentKeyword", "recentKeywordMild"));
    // Both say "it's a hard time of day" -- one is enough in a single line.
    private static final Set<String> TIME_FACTORS = new HashSet<>(Arrays.asList("selfReportedTime", "historicalTime"));

    private static final String KEYWORD_LINE = "Something on your screen caught our attention.";
    private static final Map<String, String[]> BUILTIN = new HashMap<>();
    static {
        BUILTIN.put("triggerApp", new String[] {"You're on {app}, which you flagged as a trigger."});
        BUILTIN.put("duration", new String[] {"You've been on {app} for {minutes} minutes.", "That's {minutes} minutes on {app} now."});
        BUILTIN.put("socialMedia", new String[] {"You've been scrolling on {app} {time}."});
        BUILTIN.put("selfReportedTime", new String[] {"This is a time of day you said is hard."});
        BUILTIN.put("historicalTime", new String[] {"This time of day has been tough for you before."});
        BUILTIN.put("alone", new String[] {"It's quiet around you right now."});
    }
    private static final String[] CLOSERS = {"Let's check in.", "Got a minute to check in?", "Want to check in?"};
    private static final int MAX_LENGTH = 150; // roughly what a heads-up shows before truncating

    private static final Pattern ALLOWED_PLACEHOLDER = Pattern.compile("\\{(?:app|minutes|time)\\}");
    private static final Pattern ANY_PLACEHOLDER = Pattern.compile("\\{[^}]*\\}");
    private static final Pattern MULTI_SENTENCE = Pattern.compile("[.!?]\\s+\\S");

    // A phrase from the synced bank is only used if it is still shaped like one: short, a single
    // sentence, and no placeholder other than the three filled in here. The app validated it when
    // it was written; this is the second check because it has crossed a storage boundary since.
    static boolean usable(String phrase) {
        if (phrase == null) return false;
        String p = phrase.trim();
        if (p.isEmpty() || p.length() > 90) return false;
        if (ANY_PLACEHOLDER.matcher(ALLOWED_PLACEHOLDER.matcher(p).replaceAll("")).find()) return false;
        return !MULTI_SENTENCE.matcher(p).find();
    }

    private static List<String> usableFrom(JSONObject bank, String key) {
        List<String> out = new ArrayList<>();
        JSONArray arr = bank != null ? bank.optJSONArray(key) : null;
        if (arr == null) return out;
        for (int i = 0; i < arr.length(); i++) {
            String p = arr.optString(i, null);
            if (usable(p)) out.add(p.trim());
        }
        return out;
    }

    private static String fill(String phrase, String app, long minutes, String time) {
        return phrase.replace("{app}", app).replace("{minutes}", String.valueOf(minutes)).replace("{time}", time);
    }

    /**
     * @param traceFactors RiskScorer.Result.trace's "factors" array
     * @param bank         {factorId: [phrases], closer: [phrases]} written by the on-device AI, or null
     * @param detail       the user's lock-screen-detail setting
     * @return the text, or null when the caller should use the generic wording
     */
    static String compose(JSONArray traceFactors, String app, long minutes, String timeBucket,
                          JSONObject bank, boolean detail, Random rnd) {
        if (!detail || traceFactors == null) return null;
        Set<String> fired = new HashSet<>();
        for (int i = 0; i < traceFactors.length(); i++) {
            JSONObject f = traceFactors.optJSONObject(i);
            if (f != null && f.optBoolean("fired")) fired.add(f.optString("id"));
        }
        String appName = app == null || app.isEmpty() ? "this app" : app;
        String time = TIME_WORDS.containsKey(timeBucket) ? TIME_WORDS.get(timeBucket) : "right now";

        List<String> lead = new ArrayList<>();
        boolean sawTime = false;
        boolean namedApp = false;
        for (String id : PRIORITY) {
            if (!fired.contains(id)) continue;
            if (TIME_FACTORS.contains(id)) {
                if (sawTime) continue;
                sawTime = true;
            }
            String s;
            if (KEYWORD_FACTORS.contains(id)) {
                s = KEYWORD_LINE;
            } else {
                List<String> pool = usableFrom(bank, id);
                if (pool.isEmpty() && BUILTIN.containsKey(id)) pool = Arrays.asList(BUILTIN.get(id));
                if (pool.isEmpty()) continue;
                s = fill(pool.get(rnd.nextInt(pool.size())), appName, minutes, time);
            }
            // The app is named once: a second sentence repeating it just reads as noise.
            boolean names = s.contains(appName);
            if (names && namedApp) continue;
            namedApp = namedApp || names;
            lead.add(s);
            if (lead.size() == 2) break;
        }
        if (lead.isEmpty()) return null;

        List<String> closers = usableFrom(bank, "closer");
        String closer = closers.isEmpty() ? CLOSERS[rnd.nextInt(CLOSERS.length)] : closers.get(rnd.nextInt(closers.size()));
        String text = join(lead) + " " + closer;
        // One lead sentence + the closer always fits; two only if short enough.
        if (text.length() > MAX_LENGTH) text = lead.get(0) + " " + closer;
        return text;
    }

    private static String join(List<String> parts) {
        StringBuilder sb = new StringBuilder();
        for (String p : parts) {
            if (sb.length() > 0) sb.append(' ');
            sb.append(p);
        }
        return sb.toString();
    }
}
