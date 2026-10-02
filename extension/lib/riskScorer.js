// JS port of android/.../RiskScorer.java for the browser extension. Same transparent weighted
// arithmetic (not ML -- see PURPOSE.md), same weights, bounds, thresholds, convergence bonus and
// adaptive tuning, so a score means the same thing on both platforms. Pure functions: all state
// (weights, risk context, history) is passed in, so this is unit-testable under node.
//
// Differences from Android, all because the browser can't know the thing:
//  - No "alone" factor (needs Bluetooth nearby-device scanning, Android only).
//  - "triggerApp" is a trigger SITE (user-editable domain list), "socialMedia" matches domains.
//  - "recentKeyword" is scoped to the current site, the way Android scopes it to the current app.
(function (root) {
  const Shared = root.ReclaimShared || (typeof require !== "undefined" ? require("./shared.js") : null);

  // name -> {def, min, max}; identical to RiskScorer.WEIGHT_SPECS minus "alone".
  const WEIGHT_SPECS = {
    triggerApp: { def: 30, min: 15, max: 45 },
    duration: { def: 30, min: 15, max: 45 },
    selfReportedTime: { def: 20, min: 10, max: 30 },
    historicalTime: { def: 15, min: 8, max: 22 },
    socialMedia: { def: 10, min: 5, max: 15 },
    recentKeyword: { def: 35, min: 20, max: 50 },
  };

  const ADJUST_DELTA = 2;
  const HIGH_RISK_MARGIN = 20;
  const RECENT_RECLAIM_WINDOW_MIN = 30;
  const RECENT_RECLAIM_PROTECTION = 25;
  const RECENT_KEYWORD_WINDOW_MIN = 15;

  // Same mapping as RiskScorer.TAG_TO_FACTORS (the "alone" entries drop out with that factor).
  const TAG_TO_FACTORS = {
    Stress: ["duration"],
    Boredom: ["duration"],
    Fatigue: ["selfReportedTime", "historicalTime"],
    "Late at night": ["selfReportedTime", "historicalTime"],
    "Social media": ["socialMedia"],
    "Unexpected exposure": ["recentKeyword"],
  };

  function timeBucket(hour) {
    if (hour >= 5 && hour < 12) return "Morning";
    if (hour >= 12 && hour < 17) return "Afternoon";
    if (hour >= 17 && hour < 22) return "Evening";
    return "Night";
  }

  function thresholdForIntensity(intensity) {
    if (intensity === "low") return 90;
    if (intensity === "high") return 35;
    return 60;
  }

  function loadWeights(stored) {
    const weights = {};
    for (const [name, spec] of Object.entries(WEIGHT_SPECS)) {
      const v = stored && Number.isFinite(stored[name]) ? stored[name] : spec.def;
      weights[name] = Math.max(spec.min, Math.min(spec.max, v));
    }
    return weights;
  }

  /**
   * @param {object} input
   * @param {string} input.domain               site the current browsing run is on
   * @param {number} input.sessionMinutes       minutes of continuous browsing on that site
   * @param {number} input.hour                 local hour of day, 0-23
   * @param {string[]} input.triggerDomains     user's trigger-site list
   * @param {object} input.context              synced from the app (RiskProfile.syncToNative)
   * @param {object} [input.storedWeights]      adaptive weights, if any have been tuned
   * @param {number} input.minutesSinceKeyword  minutes since a keyword match on this site (-1 = never)
   * @param {number} input.minutesSinceReclaimOpen  minutes since Reclaim was last opened (-1 = never)
   * @param {boolean} [input.strongKeywordRecent]  a Shared.STRONG_KEYWORDS match on this site in
   *                                            the keyword window -- see the floor below
   */
  function score(input) {
    const ctx = input.context || {};
    const weights = loadWeights(input.storedWeights);
    let points = 0;
    let factorCount = 0;
    const reasons = [];
    const userReasons = [];
    const factors = [];

    function fire(name, weight, reasonText, userText) {
      points += weight;
      factorCount++;
      factors.push(name);
      reasons.push(`${reasonText}(+${weight})`);
      userReasons.push(userText);
    }

    if (Shared.domainMatches(input.domain, input.triggerDomains || [])) {
      fire("triggerApp", weights.triggerApp, "trigger-site", "You're on a site you flagged as a trigger.");
    }

    // Gradual, not a cliff: full weight after 15 minutes, derived from the (adaptive) cap.
    const durationCap = weights.duration;
    const durationPoints = Math.min(durationCap, Math.round(input.sessionMinutes * (durationCap / 15)));
    if (durationPoints > 0) {
      points += durationPoints;
      factorCount++;
      factors.push("duration");
      reasons.push(`duration=${input.sessionMinutes}m(+${durationPoints})`);
      userReasons.push(`You've been there for ${input.sessionMinutes} minutes.`);
    }

    const bucket = timeBucket(input.hour);
    if ((ctx.temptingTimes || []).includes(bucket)) {
      fire("selfReportedTime", weights.selfReportedTime, "self-reported-time", "It's a time of day you told us is hard for you.");
    }
    if ((ctx.riskyTimeBuckets || []).includes(bucket)) {
      fire(
        "historicalTime",
        weights.historicalTime,
        "historical-time",
        "This time of day has been difficult for you before, based on your check-ins."
      );
    }

    const socialFlagged =
      (ctx.commonTriggers || []).includes("Social media") || (ctx.topSlipTags || []).includes("Social media");
    if (socialFlagged && Shared.domainMatches(input.domain, Shared.SOCIAL_MEDIA_DOMAINS)) {
      fire("socialMedia", weights.socialMedia, "social-media", "It's a social media site, which you've flagged as a trigger.");
    }

    // The strongest signal: an actual keyword match on this site's page text, not an inferred
    // pattern. Scoped to the current site so an earlier match elsewhere is never attributed here.
    if (input.minutesSinceKeyword >= 0 && input.minutesSinceKeyword <= RECENT_KEYWORD_WINDOW_MIN) {
      fire(
        "recentKeyword",
        weights.recentKeyword,
        "recent-keyword",
        "Something on this page recently matched a word or phrase you'd flagged."
      );
    }

    // Several different kinds of signal at once matter more than the sum of their parts. Fixed,
    // not adaptive -- same reasoning as the Android scorer.
    const convergenceBonus = factorCount >= 4 ? 30 : factorCount >= 3 ? 15 : 0;
    if (convergenceBonus > 0) {
      points += convergenceBonus;
      reasons.push(`convergence=${factorCount}factors(+${convergenceBonus})`);
      userReasons.push("Several small things are lining up right now, which together matter more than any one alone.");
    }

    // Protective: having recently opened Reclaim itself is a good sign, not a neutral one.
    if (input.minutesSinceReclaimOpen >= 0 && input.minutesSinceReclaimOpen <= RECENT_RECLAIM_WINDOW_MIN) {
      points = Math.max(0, points - RECENT_RECLAIM_PROTECTION);
      reasons.push(`recent-reclaim-use(-${RECENT_RECLAIM_PROTECTION})`);
    }

    const threshold = thresholdForIntensity(ctx.intensity);

    // Explicit-pornography floor. Everything above is an inferred pattern that has to add up; a
    // match on one of the unambiguous words is direct evidence and should not wait for minutes to
    // accumulate or depend on the intensity setting (a Low user would otherwise need 90 points).
    // Applied after the protective subtraction on purpose: having opened Reclaim recently must not
    // silence this. Fixed, not adaptive, like the convergence bonus.
    const strong = !!input.strongKeywordRecent;
    if (strong) {
      const floor = threshold + HIGH_RISK_MARGIN;
      if (points < floor) points = floor;
      factors.push("explicitKeyword");
      reasons.push(`explicit-keyword(floor ${floor})`);
      userReasons.unshift("This page matched a word strongly tied to pornography.");
    }

    return {
      score: points,
      threshold,
      strong,
      triggers: points >= threshold,
      isHighRisk: points >= threshold + HIGH_RISK_MARGIN,
      reason: reasons.join(" "),
      userReasons,
      factors,
    };
  }

  // Nudges the named factors' weights by +/- ADJUST_DELTA within bounds; returns the new full
  // weight map for the caller to persist. Unknown factor names are ignored.
  function adjustWeights(storedWeights, factorNames, increase) {
    const weights = loadWeights(storedWeights);
    const delta = increase ? ADJUST_DELTA : -ADJUST_DELTA;
    for (const name of new Set(factorNames || [])) {
      const spec = WEIGHT_SPECS[name];
      if (!spec) continue;
      weights[name] = Math.max(spec.min, Math.min(spec.max, weights[name] + delta));
    }
    return weights;
  }

  // Tag-correlation half of adaptive tuning: tags are mapped to factors and deduped first, so two
  // tags that map to the same factor nudge it once.
  function factorsForTags(tags) {
    const names = new Set();
    for (const tag of tags || []) for (const f of TAG_TO_FACTORS[tag] || []) names.add(f);
    return [...names];
  }

  const api = { WEIGHT_SPECS, score, adjustWeights, factorsForTags, timeBucket, thresholdForIntensity, loadWeights };
  root.RiskScorer = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
