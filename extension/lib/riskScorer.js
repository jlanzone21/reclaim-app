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
    // MODERATE keyword tier (the historical name is kept) and a smaller MILD tier. SEVERE is
    // deliberately not here: it is a fixed bonus, outside the adaptive system. Same numbers as
    // RiskScorer.java.
    recentKeyword: { def: 40, min: 22, max: 55 },
    recentKeywordMild: { def: 15, min: 8, max: 22 },
  };

  const ADJUST_DELTA = 2;
  const HIGH_RISK_MARGIN = 20;
  const RECENT_RECLAIM_WINDOW_MIN = 30;
  const RECENT_RECLAIM_PROTECTION = 25;
  // Per-tier recency windows, as on Android: a confirmed explicit match is worth flagging for
  // longer, an ambiguous word only if it is genuinely current.
  const KEYWORD_WINDOW_MIN = { severe: 30, moderate: 15, mild: 10 };
  // Sized so even Low intensity's 0.8x (120) clears the high-risk bar at Low's own threshold
  // (90 + 20 = 110): this tier should "always trigger a risk-nudge".
  const SEVERE_KEYWORD_BONUS = 150;

  // Same mapping as RiskScorer.TAG_TO_FACTORS (the "alone" entries drop out with that factor).
  const TAG_TO_FACTORS = {
    Stress: ["duration"],
    Boredom: ["duration"],
    Fatigue: ["selfReportedTime", "historicalTime"],
    "Late at night": ["selfReportedTime", "historicalTime"],
    "Social media": ["socialMedia"],
    "Unexpected exposure": ["recentKeyword", "recentKeywordMild"],
  };

  function timeBucket(hour) {
    if (hour >= 5 && hour < 12) return "Morning";
    if (hour >= 12 && hour < 17) return "Afternoon";
    if (hour >= 17 && hour < 22) return "Evening";
    return "Night";
  }

  // Scales the three keyword factors (and only those) with notification intensity, compounding
  // with the lower threshold -- Android's keywordIntensityMultiplier.
  function keywordIntensityMultiplier(intensity) {
    if (intensity === "low") return 0.8;
    if (intensity === "high") return 1.2;
    return 1;
  }

  // The highest tier with a match on this site still inside its own recency window, or null.
  // `matches` are {domain, keyword, at}; severity comes from the keyword, so matches stored before
  // tiers existed are classified correctly too. Used by background.js.
  function mostSevereRecentKeyword(matches, domain, now) {
    let best = null;
    const rank = { mild: 1, moderate: 2, severe: 3 };
    for (const m of matches || []) {
      if (m.domain !== domain) continue;
      const tier = Shared.KEYWORD_SEVERITY[m.keyword];
      if (!tier || (now - m.at) / 60000 > KEYWORD_WINDOW_MIN[tier]) continue;
      if (!best || rank[tier] > rank[best]) best = tier;
    }
    return best;
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
   * @param {string|null} input.keywordSeverity  highest keyword tier with a recent match on this site
   * @param {number} input.minutesSinceReclaimOpen  minutes since Reclaim was last opened (-1 = never)
   */
  function score(input) {
    const ctx = input.context || {};
    const weights = loadWeights(input.storedWeights);
    let points = 0;
    let factorCount = 0;
    const reasons = [];
    const userReasons = [];
    const factors = [];
    // Explainability, same shape as RiskScorer.java's Result.trace: every factor, fired or not,
    // with the values behind it. The on-device AI writes the user-facing explanation from this.
    // Holds no page text and never the matched keyword -- only the severity tier.
    const trace = [];
    const adjustments = [];
    const noteMiss = (id, detail) => trace.push({ id, fired: false, points: 0, detail });

    function fire(name, weight, reasonText, userText, detail) {
      points += weight;
      factorCount++;
      factors.push(name);
      reasons.push(`${reasonText}(+${weight})`);
      userReasons.push(userText);
      trace.push({ id: name, fired: true, points: weight, detail });
    }

    if (Shared.domainMatches(input.domain, input.triggerDomains || [])) {
      fire("triggerApp", weights.triggerApp, "trigger-site", "You're on a site you flagged as a trigger.", "the current site is on the user's trigger list");
    } else {
      noteMiss("triggerApp", "the current site is not on the user's trigger list");
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
      trace.push({
        id: "duration",
        fired: true,
        points: durationPoints,
        detail: `${input.sessionMinutes} minutes on the site so far (reaches the full ${durationCap} points at 15 minutes)`,
      });
    } else {
      noteMiss("duration", `the session has only just started (${input.sessionMinutes} minutes)`);
    }

    const bucket = timeBucket(input.hour);
    if ((ctx.temptingTimes || []).includes(bucket)) {
      fire("selfReportedTime", weights.selfReportedTime, "self-reported-time", "It's a time of day you told us is hard for you.", `it is currently ${bucket}, a time the user listed as tempting`);
    } else {
      noteMiss("selfReportedTime", `it is currently ${bucket}, not a time the user listed as tempting`);
    }
    if ((ctx.riskyTimeBuckets || []).includes(bucket)) {
      fire(
        "historicalTime",
        weights.historicalTime,
        "historical-time",
        "This time of day has been difficult for you before, based on your check-ins.",
        `${bucket} is a time of day where the user's past slips cluster`
      );
    } else {
      noteMiss("historicalTime", `${bucket} is not a time of day where the user's past slips cluster (or there isn't enough check-in history yet)`);
    }

    const socialFlagged =
      (ctx.commonTriggers || []).includes("Social media") || (ctx.topSlipTags || []).includes("Social media");
    if (socialFlagged && Shared.domainMatches(input.domain, Shared.SOCIAL_MEDIA_DOMAINS)) {
      fire("socialMedia", weights.socialMedia, "social-media", "It's a social media site, which you've flagged as a trigger.", "a social media site, and the user flagged social media as a trigger");
    } else {
      noteMiss(
        "socialMedia",
        Shared.domainMatches(input.domain, Shared.SOCIAL_MEDIA_DOMAINS)
          ? "a social media site, but the user hasn't flagged social media as a trigger"
          : "not a social media site"
      );
    }

    // The strongest signal: an actual keyword match on this site's page text, not an inferred
    // pattern. Scoped to the current site so an earlier match elsewhere is never attributed here.
    // Only the single highest tier still in its window counts, never stacked, and all three scale
    // with notification intensity.
    const mult = keywordIntensityMultiplier(ctx.intensity);
    const severity = input.keywordSeverity || null;
    if (severity === "severe") {
      const w = Math.round(SEVERE_KEYWORD_BONUS * mult);
      fire(
        "recentKeywordSevere",
        w,
        "recent-keyword-severe",
        "Something explicit was just seen on this site -- this matters enough to flag right away.",
        `page text on this site recently matched the most serious keyword tier (within ${KEYWORD_WINDOW_MIN.severe} minutes); this tier always triggers`
      );
    } else if (severity === "moderate") {
      fire(
        "recentKeyword",
        Math.round(weights.recentKeyword * mult),
        "recent-keyword",
        "Something on this page recently matched a word or phrase you'd flagged.",
        `page text on this site recently matched the moderate keyword tier (within ${KEYWORD_WINDOW_MIN.moderate} minutes)`
      );
    } else if (severity === "mild") {
      fire(
        "recentKeywordMild",
        Math.round(weights.recentKeywordMild * mult),
        "recent-keyword-mild",
        "Something on this page recently had a word or phrase worth noticing.",
        `page text on this site recently matched the mildest keyword tier (within ${KEYWORD_WINDOW_MIN.mild} minutes)`
      );
    } else {
      noteMiss("recentKeyword", "no keyword match on this site's page text within its recency window");
    }

    // Several different kinds of signal at once matter more than the sum of their parts. Fixed,
    // not adaptive -- same reasoning as the Android scorer.
    const convergenceBonus = factorCount >= 4 ? 30 : factorCount >= 3 ? 15 : 0;
    if (convergenceBonus > 0) {
      points += convergenceBonus;
      reasons.push(`convergence=${factorCount}factors(+${convergenceBonus})`);
      userReasons.push("Several small things are lining up right now, which together matter more than any one alone.");
      adjustments.push({ id: "convergence", points: convergenceBonus, detail: `${factorCount} different kinds of signal were true at the same time` });
    }

    // Protective: having recently opened Reclaim itself is a good sign, not a neutral one.
    if (input.minutesSinceReclaimOpen >= 0 && input.minutesSinceReclaimOpen <= RECENT_RECLAIM_WINDOW_MIN) {
      const before = points;
      points = Math.max(0, points - RECENT_RECLAIM_PROTECTION);
      adjustments.push({
        id: "recentReclaimUse",
        points: points - before,
        detail: `the user opened Reclaim ${input.minutesSinceReclaimOpen} minutes ago, which is a protective sign`,
      });
      reasons.push(`recent-reclaim-use(-${RECENT_RECLAIM_PROTECTION})`);
    }

    const threshold = thresholdForIntensity(ctx.intensity);

    const isHighRisk = points >= threshold + HIGH_RISK_MARGIN;
    return {
      score: points,
      threshold,
      severe: severity === "severe",
      triggers: points >= threshold,
      isHighRisk,
      reason: reasons.join(" "),
      userReasons,
      factors,
      trace: {
        platform: "web",
        score: points,
        threshold,
        intensity: ctx.intensity || "medium",
        timeBucket: bucket,
        sessionMinutes: input.sessionMinutes,
        highRisk: isHighRisk,
        factors: trace,
        adjustments,
      },
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

  const api = { mostSevereRecentKeyword, keywordIntensityMultiplier, WEIGHT_SPECS, score, adjustWeights, factorsForTags, timeBucket, thresholdForIntensity, loadWeights };
  root.RiskScorer = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
