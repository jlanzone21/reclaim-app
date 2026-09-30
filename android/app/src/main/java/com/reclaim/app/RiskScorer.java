package com.reclaim.app;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.Calendar;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/**
 * Transparent, weighted scoring -- not ML, see PURPOSE.md for why (a single person's on-device
 * check-in history is a handful of entries, nowhere near enough to train anything real, and this
 * needs to be debuggable: every point added is traceable to a specific, explainable reason).
 *
 * The goal per the plan: notice a lead-up pattern and intercept BEFORE a slip, not react to
 * evidence one is already happening. So this mostly weighs context that has actually preceded this
 * person's own past slips (RiskProfile, mirrored from CheckInStore) and what they told us to
 * watch for (UserPreferencesStore's tempting_times/common_triggers) -- proxies, not direct
 * evidence. The one exception is recentKeyword: an actual keyword match against on-screen text
 * captured on the allowlist (TrackingAccessibilityService), which IS direct evidence, not a proxy
 * -- previously kept out of this scorer entirely and left as an Insights-only passive signal;
 * user explicitly asked for that reversed. Scoped to the current session's package (see its block
 * in score() below), not "any match anywhere," and weighted higher than the proxy factors for
 * exactly that reason.
 *
 * Adaptive tuning (v2): the base factor weights below are stored, mutable values
 * (LocalSignalsDb.app_meta's "risk_weights"), not Java literals -- adjustWeights() nudges them a
 * small, fixed amount, two independent ways (both land in the same risk_weights store, and both
 * can adjust the same check-in's outcome -- deliberately not deduplicated against each other, see
 * LocalSignalsPlugin.recordCheckinOutcome):
 *   1. Notification correlation -- whether a check-in shortly after a notification was "resisted"
 *      or "slipped" reinforces/eases off whichever factors actually fired in that notification.
 *   2. Tag correlation -- independent of any notification, which condition tags the person picked
 *      for THIS check-in (TAG_TO_FACTORS below) reinforces/eases off the factors that tag plausibly
 *      relates to. Only tags with a reasonably direct, explainable connection are mapped; several
 *      (Feeling low, Celebrating, Other, Anger or frustration) are deliberately left unmapped
 *      rather than force a guess with no real signal behind it.
 * Deliberately NOT the convergence bonus from RiskScorer's own history, and NOT ML or the
 * on-device LLM -- a handful of check-ins is nowhere near enough to train anything, and nudging a
 * number is a math problem, not a language one. Bounded per-factor so a small, sparse data set
 * can't swing a weight far off its starting point in one or two events.
 */
final class RiskScorer {
    private RiskScorer() {}

    // Common social-media packages, same list as LocalSignalsDb's default allowlist seed --
    // reused here to recognize "on a social media app" for the commonTriggers/topSlipTags
    // "Social media" tag match, independent of whether this specific app is on this person's
    // allowlist too (that's the separate, stronger triggerApp signal below).
    private static final Set<String> SOCIAL_MEDIA_PACKAGES = new HashSet<>();
    static {
        SOCIAL_MEDIA_PACKAGES.add("com.instagram.android");
        SOCIAL_MEDIA_PACKAGES.add("com.zhiliaoapp.musically");
        SOCIAL_MEDIA_PACKAGES.add("com.reddit.frontpage");
        SOCIAL_MEDIA_PACKAGES.add("com.twitter.android");
        SOCIAL_MEDIA_PACKAGES.add("com.snapchat.android");
        SOCIAL_MEDIA_PACKAGES.add("com.facebook.katana");
    }

    private static final String TAG = "RiskScorer";
    private static final String META_KEY_WEIGHTS = "risk_weights";

    // "duration" is really a cap in points -- the +2/minute rate is derived from it (rate =
    // weight/15) so "reaches full weight after 15 minutes" stays true as the cap itself adapts.
    private static final class WeightSpec {
        final int def, min, max;
        WeightSpec(int def, int min, int max) { this.def = def; this.min = min; this.max = max; }
    }

    // name -> {default, min, max}. Bounds are roughly half to one-and-a-half times the default --
    // wide enough for real adjustment to matter, narrow enough that a sparse data set can't send a
    // weight to zero or let it dominate every other factor.
    private static final Map<String, WeightSpec> WEIGHT_SPECS = new LinkedHashMap<>();
    static {
        WEIGHT_SPECS.put("triggerApp", new WeightSpec(30, 15, 45));
        WEIGHT_SPECS.put("duration", new WeightSpec(30, 15, 45));
        WEIGHT_SPECS.put("selfReportedTime", new WeightSpec(20, 10, 30));
        WEIGHT_SPECS.put("historicalTime", new WeightSpec(15, 8, 22));
        WEIGHT_SPECS.put("socialMedia", new WeightSpec(10, 5, 15));
        WEIGHT_SPECS.put("alone", new WeightSpec(15, 8, 25));
        // Higher default than the usage-pattern proxies above: this fires on an actual keyword
        // match against captured on-screen text, not an inferred pattern -- see its block in
        // score() below.
        WEIGHT_SPECS.put("recentKeyword", new WeightSpec(35, 20, 50));
    }

    // Small and fixed on purpose -- see class doc comment. ~7-8 correlated events to walk a weight
    // from its default to a bound, not one or two.
    private static final int ADJUST_DELTA = 2;

    // Which factor(s) a self-reported check-in tag (CONDITION_TAGS, constants.js) plausibly
    // relates to, for the tag-correlation half of adjustWeights (see class doc comment). Picking
    // more than one tag that maps to the same factor doesn't double-nudge it -- see
    // adjustWeightsForTags, which dedupes into a set before adjusting.
    private static final Map<String, String[]> TAG_TO_FACTORS = new HashMap<>();
    static {
        TAG_TO_FACTORS.put("Stress", new String[] {"duration"});
        TAG_TO_FACTORS.put("Boredom", new String[] {"duration"});
        TAG_TO_FACTORS.put("Loneliness", new String[] {"alone"});
        TAG_TO_FACTORS.put("Alone and unsupervised", new String[] {"alone"});
        TAG_TO_FACTORS.put("Conflict with someone", new String[] {"alone"});
        TAG_TO_FACTORS.put("Fatigue", new String[] {"selfReportedTime", "historicalTime"});
        TAG_TO_FACTORS.put("Late at night", new String[] {"selfReportedTime", "historicalTime"});
        TAG_TO_FACTORS.put("Social media", new String[] {"socialMedia"});
        TAG_TO_FACTORS.put("Unexpected exposure", new String[] {"recentKeyword"});
        // Deliberately absent, not mapped to anything: "Anger or frustration", "Feeling low",
        // "Celebrating or rewarding myself", "Other" -- no factor here has a direct enough
        // relationship to these to be worth guessing at.
    }

    static final class Result {
        final int score;
        final int threshold;
        final String reason; // internal, logcat-only -- not shown to the user
        final JSONArray userReasons; // plain-language, shown in-app once opened -- see PendingRiskAlert
        final JSONArray factors; // machine-readable names of which factors fired, for adjustWeights

        Result(int score, int threshold, String reason, JSONArray userReasons, JSONArray factors) {
            this.score = score;
            this.threshold = threshold;
            this.reason = reason;
            this.userReasons = userReasons;
            this.factors = factors;
        }

        boolean triggers() {
            return score >= threshold;
        }

        // Which suggested action RiskNudgeMonitor's notification offers -- a lighter-touch nudge
        // (read a verse) for a score that just cleared the bar, "call your accountability partner"
        // reserved for a score well past it. Relative to THIS user's own threshold (not a fixed
        // number) so it scales with their notification_intensity setting the same way triggering
        // itself does. +20 is roughly one extra factor's worth of weight (weights range ~10-30) --
        // enough separation that "high" means something more than "technically triggered."
        private static final int HIGH_RISK_MARGIN = 20;

        boolean isHighRisk() {
            return score >= threshold + HIGH_RISK_MARGIN;
        }
    }

    static Result score(Context ctx, String currentPackage, long sessionMinutes) {
        LocalSignalsDb db = LocalSignalsDb.getInstance(ctx);
        Map<String, Integer> weights = loadWeights(db);
        int points = 0;
        int factorCount = 0;
        StringBuilder reason = new StringBuilder();
        JSONArray userReasons = new JSONArray();
        JSONArray factors = new JSONArray();

        if (db.isAllowlisted(currentPackage)) {
            int w = weights.get("triggerApp");
            points += w;
            factorCount++;
            factors.put("triggerApp");
            reason.append("trigger-app(+").append(w).append(") ");
            userReasons.put("You're on an app you flagged as a trigger.");
        }

        // Gradual, not a cliff: rate is derived from the cap so "reaches full weight after 15
        // minutes" stays true as the cap itself adapts -- a long session doesn't keep adding
        // weight forever once the point's already made.
        int durationCap = weights.get("duration");
        int durationPoints = (int) Math.min(durationCap, Math.round(sessionMinutes * (durationCap / 15.0)));
        if (durationPoints > 0) {
            points += durationPoints;
            factorCount++;
            factors.put("duration");
            reason.append("duration=").append(sessionMinutes).append("m(+").append(durationPoints).append(") ");
            userReasons.put("You've been there for " + sessionMinutes + " minutes.");
        }

        String currentBucket = timeBucket(Calendar.getInstance().get(Calendar.HOUR_OF_DAY));
        Set<String> temptingTimes = parseJsonArray(db.getMeta("tempting_times"));
        if (temptingTimes.contains(currentBucket)) {
            int w = weights.get("selfReportedTime");
            points += w;
            factorCount++;
            factors.put("selfReportedTime");
            reason.append("self-reported-time(+").append(w).append(") ");
            userReasons.put("It's a time of day you told us is hard for you.");
        }

        Set<String> riskyBuckets = parseJsonArray(db.getMeta("risky_time_buckets"));
        if (riskyBuckets.contains(currentBucket)) {
            int w = weights.get("historicalTime");
            points += w;
            factorCount++;
            factors.put("historicalTime");
            reason.append("historical-time(+").append(w).append(") ");
            userReasons.put("This time of day has been difficult for you before, based on your check-ins.");
        }

        Set<String> commonTriggers = parseJsonArray(db.getMeta("common_triggers"));
        Set<String> topSlipTags = parseJsonArray(db.getMeta("top_slip_tags"));
        boolean socialMediaFlagged = commonTriggers.contains("Social media") || topSlipTags.contains("Social media");
        if (socialMediaFlagged && SOCIAL_MEDIA_PACKAGES.contains(currentPackage)) {
            int w = weights.get("socialMedia");
            points += w;
            factorCount++;
            factors.put("socialMedia");
            reason.append("social-media(+").append(w).append(") ");
            userReasons.put("It's a social media app, which you've flagged as a trigger.");
        }

        // "0" specifically (not "1-2" etc.) -- a real signal of physical solitude, not just "not
        // many people nearby." null (no scan yet, or permission not granted) never fires this --
        // missing data means "unknown," not "alone imagined as the safer default."
        if ("0".equals(db.mostRecentNearbyDeviceBucket())) {
            int w = weights.get("alone");
            points += w;
            factorCount++;
            factors.put("alone");
            reason.append("alone(+").append(w).append(") ");
            userReasons.put("No one else seems to be nearby right now.");
        }

        // The strongest signal available: not a usage-pattern proxy like the factors above, but an
        // actual keyword match against on-screen text captured on THIS app (TrackingAccessibility
        // Service, allowlist-gated -- see PURPOSE.md). Scoped to currentPackage, not "any match
        // anywhere," so a match from an unrelated earlier app/session never gets attributed to a
        // totally different later one. Weighted higher than the proxy factors above on purpose --
        // confirmed content beats inferred pattern.
        int minutesSinceKeyword = LocalSignalsDb.minutesSince(db.mostRecentKeywordMatchAt(currentPackage));
        if (minutesSinceKeyword >= 0 && minutesSinceKeyword <= RECENT_KEYWORD_WINDOW_MIN) {
            int w = weights.get("recentKeyword");
            points += w;
            factorCount++;
            factors.put("recentKeyword");
            reason.append("recent-keyword(+").append(w).append(") ");
            userReasons.put("Something on this screen recently matched a word or phrase you'd flagged.");
        }

        // Convergence bonus: any single factor above is weak evidence on its own (being on social
        // media, or it being late, doesn't mean someone is struggling) -- but several of them true
        // at once is a materially different, stronger signal than the same points spread thin would
        // suggest. Tiered rather than linear so 3+ factors landing together is disproportionately
        // significant, not just "one more addend." Counts which distinct factors fired, not their
        // magnitude -- a 1-minute session counts the same as a 15-minute one for this purpose, since
        // this is about how many different kinds of signal are converging, not how strong any one is.
        // Fixed, not adjusted by adjustWeights -- see class doc comment.
        int convergenceBonus = factorCount >= 4 ? 30 : factorCount >= 3 ? 15 : 0;
        if (convergenceBonus > 0) {
            points += convergenceBonus;
            reason.append("convergence=").append(factorCount).append("factors(+").append(convergenceBonus).append(") ");
            userReasons.put("Several small things are lining up right now, which together matter more than any one alone.");
        }

        // Protective, not a risk factor: recently having actually opened Reclaim itself is a good
        // sign, not a neutral one -- someone who's actively engaging with recovery content is less
        // likely to be mid-slip than the raw usage-pattern factors alone would suggest. Fixed, not
        // part of factors[]/adjustWeights, same reasoning as the convergence bonus above: this is a
        // deliberate design choice, not something a sparse per-user data set should be nudging.
        // Subtracted, not a threshold change, so it still shows up in the log/reason trail.
        int minutesSinceOpen = LocalSignalsDb.minutesSince(db.getMeta("last_reclaim_open_at"));
        if (minutesSinceOpen >= 0 && minutesSinceOpen <= RECENT_RECLAIM_WINDOW_MIN) {
            points = Math.max(0, points - RECENT_RECLAIM_PROTECTION);
            reason.append("recent-reclaim-use(-").append(RECENT_RECLAIM_PROTECTION).append(") ");
        }

        int threshold = thresholdForIntensity(db.getMeta("notification_intensity"));
        return new Result(points, threshold, reason.toString().trim(), userReasons, factors);
    }

    private static final int RECENT_RECLAIM_WINDOW_MIN = 30;
    private static final int RECENT_RECLAIM_PROTECTION = 25;

    // Same window as the periodic background check's own cadence (BaselineSampleWorker, ~15 min --
    // see RiskNudgeMonitor's class doc comment): a keyword match older than one sampling cycle is
    // stale, not "currently happening."
    private static final int RECENT_KEYWORD_WINDOW_MIN = 15;

    private static Map<String, Integer> loadWeights(LocalSignalsDb db) {
        Map<String, Integer> weights = new HashMap<>();
        for (Map.Entry<String, WeightSpec> e : WEIGHT_SPECS.entrySet()) weights.put(e.getKey(), e.getValue().def);
        String json = db.getMeta(META_KEY_WEIGHTS);
        if (json != null && !json.isEmpty()) {
            try {
                JSONObject obj = new JSONObject(json);
                for (String key : WEIGHT_SPECS.keySet()) {
                    if (obj.has(key)) weights.put(key, obj.getInt(key));
                }
            } catch (JSONException e) {
                // Malformed -- fall back to defaults rather than failing the whole score.
            }
        }
        return weights;
    }

    // Called by LocalSignalsPlugin.recordCheckinOutcome once it's confirmed a check-in falls
    // within the correlation window of a notification that fired. increase=true means "slipped"
    // (the factors that fired correctly flagged real risk -- reinforce them); false means
    // "resisted" (the flagged risk didn't materialize into a slip -- ease off slightly).
    static void adjustWeights(Context ctx, JSONArray firedFactors, boolean increase) {
        if (firedFactors == null) return;
        Set<String> names = new HashSet<>();
        for (int i = 0; i < firedFactors.length(); i++) {
            String name = firedFactors.optString(i, null);
            if (name != null) names.add(name);
        }
        adjustWeights(ctx, names, increase);
    }

    // The tag-correlation half of adaptive tuning (see class doc comment) -- called by
    // LocalSignalsPlugin.recordCheckinOutcome for every check-in, independent of whether it also
    // correlated with a preceding notification. Maps each selected tag to its factor(s) via
    // TAG_TO_FACTORS, deduped into a set first so picking two tags that map to the same factor
    // (e.g. both "Fatigue" and "Late at night") nudges it once, not twice.
    static void adjustWeightsForTags(Context ctx, JSONArray tags, boolean increase) {
        if (tags == null) return;
        Set<String> names = new HashSet<>();
        for (int i = 0; i < tags.length(); i++) {
            String tag = tags.optString(i, null);
            String[] mapped = tag != null ? TAG_TO_FACTORS.get(tag) : null;
            if (mapped != null) names.addAll(java.util.Arrays.asList(mapped));
        }
        adjustWeights(ctx, names, increase);
    }

    private static void adjustWeights(Context ctx, Set<String> names, boolean increase) {
        if (names.isEmpty()) return;
        LocalSignalsDb db = LocalSignalsDb.getInstance(ctx);
        Map<String, Integer> weights = loadWeights(db);
        int delta = increase ? ADJUST_DELTA : -ADJUST_DELTA;

        for (String name : names) {
            WeightSpec spec = WEIGHT_SPECS.get(name);
            if (spec == null) continue; // unknown/stale factor name -- ignore rather than fail
            int current = weights.containsKey(name) ? weights.get(name) : spec.def;
            weights.put(name, Math.max(spec.min, Math.min(spec.max, current + delta)));
        }

        JSONObject out = new JSONObject();
        try {
            for (Map.Entry<String, Integer> e : weights.entrySet()) out.put(e.getKey(), e.getValue());
        } catch (JSONException e) {
            return; // shouldn't happen (plain ints), but don't half-write weights if it does
        }
        db.setMeta(META_KEY_WEIGHTS, out.toString());
        Log.d(TAG, "adjusted weights " + (increase ? "+" : "-") + ADJUST_DELTA + " for " + names + " -> " + out);
    }

    // Same four buckets as TEMPTING_TIME_BUCKETS (constants.js) / RiskProfile (riskProfile.js) --
    // must match or a "risky time" here would silently mean a different window than what the
    // person actually selected.
    static String timeBucket(int hour) {
        if (hour >= 5 && hour < 12) return "Morning";
        if (hour >= 12 && hour < 17) return "Afternoon";
        if (hour >= 17 && hour < 22) return "Evening";
        return "Night";
    }

    // Higher intensity = lower bar to notify. Medium is the default both here and in
    // UserPreferencesStore's own default, so an unset/unsynced value behaves the same as medium.
    private static int thresholdForIntensity(String intensity) {
        if ("low".equals(intensity)) return 90;
        if ("high".equals(intensity)) return 35;
        return 60;
    }

    private static Set<String> parseJsonArray(String json) {
        Set<String> out = new HashSet<>();
        if (json == null || json.isEmpty()) return out;
        try {
            JSONArray arr = new JSONArray(json);
            for (int i = 0; i < arr.length(); i++) out.add(arr.getString(i));
        } catch (JSONException e) {
            // Malformed/missing meta -- treat as empty rather than failing the whole score.
        }
        return out;
    }
}
