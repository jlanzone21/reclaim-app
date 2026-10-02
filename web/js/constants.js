/**
 * Small fixed lists that don't belong in the resources database — not
 * content the agent "looks up," just app-wide constants.
 */

const CRISIS_LINES = [
  {
    name: "988 Suicide & Crisis Lifeline",
    phone: "988",
    detail: "Call or text 988. Free, confidential, available 24/7.",
  },
  {
    name: "SAMHSA National Helpline",
    phone: "1-800-662-4357",
    detail: "Free, confidential, 24/7 treatment referral and information service.",
  },
];

const CRISIS_REPLY =
  "I'm really glad you told me. Please reach out to one of the numbers above right now, or call 911 if you're in immediate danger — a trained person can help in a way I can't. You don't have to go through this moment alone.";

// Same four buckets insightsView.js's time-of-day chart already uses — kept in sync by hand since
// there's no shared source yet, but the labels must match or "when slips happen" and "when you're
// tempted" would silently mean different things to the same user.
const TEMPTING_TIME_BUCKETS = ["Morning", "Afternoon", "Evening", "Night"];

// Matches the `method` field on coping_mechanism rows (seedData.js) exactly -- getCopingMechanisms
// (resourceRepo.js) prioritizes whichever of these the user picked in onboarding/preferences.
const COPING_METHOD_OPTIONS = ["Scripture", "Breathing", "Accountability partner", "Journaling", "Walk", "Devotional"];

const CONDITION_TAGS = [
  "Stress",
  "Loneliness",
  "Boredom",
  "Fatigue",
  "Anger or frustration",
  "Conflict with someone",
  "Alone and unsupervised",
  "Late at night",
  "Social media",
  "Feeling low",
  "Celebrating or rewarding myself",
  "Unexpected exposure",
  "Other",
];

const ENCOURAGEMENTS = [
  "Reaching out today, even just to a chat window, is a real step. Keep going.",
  "One slip doesn't erase your progress. What matters is the next honest step you take.",
  "You weren't made to fight this alone — that's exactly why community and accountability matter so much.",
  "Shame says hide. Grace says come closer. Consider reaching out to someone today.",
  "Recovery is rarely a straight line. Be patient with yourself, and stay connected to people who know your story.",
];
