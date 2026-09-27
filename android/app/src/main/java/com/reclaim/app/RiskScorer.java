package com.reclaim.app;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONException;

import java.util.Calendar;
import java.util.HashSet;
import java.util.Set;

/**
 * Transparent, weighted scoring -- not ML, see PURPOSE.md for why (a single person's on-device
 * check-in history is a handful of entries, nowhere near enough to train anything real, and this
 * needs to be debuggable: every point added is traceable to a specific, explainable reason).
 *
 * The goal per the plan: notice a lead-up pattern and intercept BEFORE a slip, not react to
 * evidence one is already happening. So this weighs context that has actually preceded this
 * person's own past slips (RiskProfile, mirrored from CheckInStore) and what they told us to
 * watch for (UserPreferencesStore's tempting_times/common_triggers), not keyword matches --
 * those stay a separate, passive signal for Insights, not an input here.
 *
 * A planned v2 (not built yet): a small deterministic feedback loop that nudges these weights
 * based on whether a check-in shortly after a notification was "resisted" or "slipped" --
 * genuinely adaptive without needing real ML or involving the on-device LLM in numeric tuning.
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

    static final class Result {
        final int score;
        final int threshold;
        final String reason; // internal, logcat-only -- not shown to the user
        final JSONArray userReasons; // plain-language, shown in-app once opened -- see PendingRiskAlert

        Result(int score, int threshold, String reason, JSONArray userReasons) {
            this.score = score;
            this.threshold = threshold;
            this.reason = reason;
            this.userReasons = userReasons;
        }

        boolean triggers() {
            return score >= threshold;
        }
    }

    static Result score(Context ctx, String currentPackage, long sessionMinutes) {
        LocalSignalsDb db = LocalSignalsDb.getInstance(ctx);
        int points = 0;
        int factorCount = 0;
        StringBuilder reason = new StringBuilder();
        JSONArray userReasons = new JSONArray();

        if (db.isAllowlisted(currentPackage)) {
            points += 30;
            factorCount++;
            reason.append("trigger-app(+30) ");
            userReasons.put("You're on an app you flagged as a trigger.");
        }

        // Gradual, not a cliff: +2/minute, capped at +30 (15 minutes) so a long session doesn't
        // keep adding weight forever once the point's already made.
        int durationPoints = (int) Math.min(30, sessionMinutes * 2);
        if (durationPoints > 0) {
            points += durationPoints;
            factorCount++;
            reason.append("duration=").append(sessionMinutes).append("m(+").append(durationPoints).append(") ");
            userReasons.put("You've been there for " + sessionMinutes + " minutes.");
        }

        String currentBucket = timeBucket(Calendar.getInstance().get(Calendar.HOUR_OF_DAY));
        Set<String> temptingTimes = parseJsonArray(db.getMeta("tempting_times"));
        if (temptingTimes.contains(currentBucket)) {
            points += 20;
            factorCount++;
            reason.append("self-reported-time(+20) ");
            userReasons.put("It's a time of day you told us is hard for you.");
        }

        Set<String> riskyBuckets = parseJsonArray(db.getMeta("risky_time_buckets"));
        if (riskyBuckets.contains(currentBucket)) {
            points += 15;
            factorCount++;
            reason.append("historical-time(+15) ");
            userReasons.put("This time of day has been difficult for you before, based on your check-ins.");
        }

        Set<String> commonTriggers = parseJsonArray(db.getMeta("common_triggers"));
        Set<String> topSlipTags = parseJsonArray(db.getMeta("top_slip_tags"));
        boolean socialMediaFlagged = commonTriggers.contains("Social media") || topSlipTags.contains("Social media");
        if (socialMediaFlagged && SOCIAL_MEDIA_PACKAGES.contains(currentPackage)) {
            points += 10;
            factorCount++;
            reason.append("social-media(+10) ");
            userReasons.put("It's a social media app, which you've flagged as a trigger.");
        }

        // Convergence bonus: any single factor above is weak evidence on its own (being on social
        // media, or it being late, doesn't mean someone is struggling) -- but several of them true
        // at once is a materially different, stronger signal than the same points spread thin would
        // suggest. Tiered rather than linear so 3+ factors landing together is disproportionately
        // significant, not just "one more addend." Counts which distinct factors fired, not their
        // magnitude -- a 1-minute session counts the same as a 15-minute one for this purpose, since
        // this is about how many different kinds of signal are converging, not how strong any one is.
        int convergenceBonus = factorCount >= 4 ? 30 : factorCount >= 3 ? 15 : 0;
        if (convergenceBonus > 0) {
            points += convergenceBonus;
            reason.append("convergence=").append(factorCount).append("factors(+").append(convergenceBonus).append(") ");
            userReasons.put("Several small things are lining up right now, which together matter more than any one alone.");
        }

        int threshold = thresholdForIntensity(db.getMeta("notification_intensity"));
        return new Result(points, threshold, reason.toString().trim(), userReasons);
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
