/**
 * Seed content for the Reclaim resource database. Loaded once into SQLite
 * (via sql.js) the first time the app runs on a device — see db.js.
 *
 * Everything with is_sample=1 is placeholder/example content: fabricated
 * sermon speakers, article bylines, church names, and (555) phone numbers.
 * Replace it with real, rights-cleared content and real local resources
 * before anyone relies on this app.
 *
 * Schema (see db.js SCHEMA_SQL):
 *   resources(id, type, title, subtitle, body, url, contact, area,
 *             duration_min, tags, is_sample, created_at)
 *   bible_plan_days(id, plan_id, day_number, reference, reflection)
 */

const SEED_RESOURCES = [
  // ---- scripture ----
  { type: "scripture", title: "Psalm 34:18", body: "The LORD is close to the brokenhearted and saves those who are crushed in spirit.", tags: ["shame", "brokenness", "despair"] },
  { type: "scripture", title: "Romans 8:1", body: "Therefore, there is now no condemnation for those who are in Christ Jesus.", tags: ["shame", "guilt", "identity"] },
  { type: "scripture", title: "1 Corinthians 10:13", body: "No temptation has overtaken you except what is common to mankind. And God is faithful; he will not let you be tempted beyond what you can bear, but when you are tempted, he will also provide a way out so that you can endure it.", tags: ["temptation", "struggle", "hope"] },
  { type: "scripture", title: "James 5:16", body: "Therefore confess your sins to each other and pray for each other so that you may be healed.", tags: ["accountability", "community", "confession"] },
  { type: "scripture", title: "2 Corinthians 5:17", body: "Therefore, if anyone is in Christ, the new creation has come: The old has gone, the new is here!", tags: ["identity", "freedom", "hope"] },
  { type: "scripture", title: "Galatians 6:2", body: "Carry each other's burdens, and in this way you will fulfill the law of Christ.", tags: ["community", "accountability", "support"] },
  { type: "scripture", title: "Psalm 139:23-24", body: "Search me, God, and know my heart; test me and know my anxious thoughts. See if there is any offensive way in me, and lead me in the way everlasting.", tags: ["struggle", "honesty", "growth"] },
  { type: "scripture", title: "Lamentations 3:22-23", body: "Because of the LORD's great love we are not consumed, for his compassions never fail. They are new every morning; great is your faithfulness.", tags: ["hope", "relapse", "perseverance"] },

  // ---- sermons ----
  { type: "sermon", title: "Freedom from Shame", subtitle: "Example Pastor A. Reyes · Restored", url: "#", duration_min: 34, tags: ["shame", "freedom"], is_sample: 1 },
  { type: "sermon", title: "Walking in the Light", subtitle: "Example Pastor J. Whitfield · Honest Faith", url: "#", duration_min: 28, tags: ["honesty", "accountability"], is_sample: 1 },
  { type: "sermon", title: "You Are Not Your Worst Day", subtitle: "Example Pastor M. Osei · Identity in Christ", url: "#", duration_min: 41, tags: ["identity", "shame"], is_sample: 1 },
  { type: "sermon", title: "When Willpower Isn't Enough", subtitle: "Example Pastor R. Diaz · Grace Over Grit", url: "#", duration_min: 37, tags: ["struggle", "grace", "relapse"], is_sample: 1 },
  { type: "sermon", title: "The Power of Being Known", subtitle: "Example Pastor L. Kim · Community", url: "#", duration_min: 31, tags: ["community", "accountability", "loneliness"], is_sample: 1 },

  // ---- articles ----
  { type: "article", title: "Understanding the Brain Science of Pornography Addiction", subtitle: "Example author: Dr. S. Patton", body: "A plain-language look at how compulsive pornography use affects the brain's reward pathways, and why willpower alone often isn't enough to break the cycle.", url: "#", tags: ["struggle", "education"], is_sample: 1 },
  { type: "article", title: "How to Talk to Your Spouse About This Struggle", subtitle: "Example author: C. Bennett, LMFT", body: "Practical guidance for having an honest, non-defensive conversation with a spouse or partner about pornography use — timing, wording, and what to expect.", url: "#", tags: ["community", "honesty", "relationships"], is_sample: 1 },
  { type: "article", title: "Why Accountability Partners Work", subtitle: "Example author: Reclaim Editorial", body: "The research and reasoning behind why regular check-ins with another person measurably improve recovery outcomes.", url: "#", tags: ["accountability", "community"], is_sample: 1 },
  { type: "article", title: "Recognizing Your Triggers", subtitle: "Example author: Reclaim Editorial", body: "A guide to identifying the emotional states, times of day, and situations that most often precede a slip — the first step toward interrupting the pattern.", url: "#", tags: ["struggle", "triggers", "relapse"], is_sample: 1 },
  { type: "article", title: "The Role of Community in Recovery", subtitle: "Example author: Reclaim Editorial", body: "Why isolation is one of the strongest predictors of relapse, and what meaningfully re-engaging with community can look like in practice.", url: "#", tags: ["community", "loneliness"], is_sample: 1 },

  // ---- devotionals ----
  { type: "devotional", title: "Today's Battle Isn't Yours Alone", body: "A short reflection on 1 Corinthians 10:13 — that every temptation comes with a way out, even when it doesn't feel like it in the moment.", tags: ["temptation", "hope"], is_sample: 1 },
  { type: "devotional", title: "When Shame Lies to You", body: "Shame tells you to hide. Grace says come closer. A short reflection on Romans 8:1 and what it means to stop hiding.", tags: ["shame", "grace"], is_sample: 1 },
  { type: "devotional", title: "Small Steps, Real Change", body: "Recovery rarely looks like a single dramatic moment — it looks like a thousand small, boring, faithful choices. A reflection on perseverance.", tags: ["perseverance", "growth"], is_sample: 1 },
  { type: "devotional", title: "The God Who Sees You", body: "A short reflection on being fully known and fully loved anyway, drawing on the story of Hagar in Genesis 16.", tags: ["identity", "shame"], is_sample: 1 },
  { type: "devotional", title: "Grace for the Relapse", body: "A slip is not the end of the story. A reflection on Lamentations 3:22-23 — new mercies, every morning, including this one.", tags: ["relapse", "grace", "hope"], is_sample: 1 },

  // ---- coping mechanisms ----
  { type: "coping_mechanism", title: "Urge Surfing", body: "Urges peak and fade, usually within 15-20 minutes, whether or not you act on them. Instead of fighting the urge, try noticing it like a wave: name it, sit with it, and let it crest and pass without acting.", tags: ["temptation", "in-the-moment"], is_sample: 1 },
  { type: "coping_mechanism", title: "The HALT Check", body: "Before reacting to an urge, ask: am I Hungry, Angry, Lonely, or Tired? Urges are often a stand-in for one of these unmet needs. Naming the real need can point you to the real fix.", tags: ["triggers", "in-the-moment"], is_sample: 1 },
  { type: "coping_mechanism", title: "Change Your Environment", body: "Physically move — leave the room, go outside, go where other people are. Removing yourself from the location tied to the urge breaks the pattern more reliably than trying to white-knuckle it in place.", tags: ["in-the-moment", "triggers"], is_sample: 1 },
  { type: "coping_mechanism", title: "Reach Out Immediately", body: "Text or call your accountability partner the moment you notice an urge, not after. Saying it out loud to another person changes the moment.", tags: ["accountability", "in-the-moment"], is_sample: 1 },
  { type: "coping_mechanism", title: "5-4-3-2-1 Grounding", body: "Name 5 things you can see, 4 you can touch, 3 you can hear, 2 you can smell, 1 you can taste. A simple sensory grounding technique to interrupt an escalating moment.", tags: ["in-the-moment", "anxiety"], is_sample: 1 },
  { type: "coping_mechanism", title: "Move Your Body", body: "A short walk, push-ups, or any physical exertion changes your physiological state and can interrupt an urge cycle faster than willpower alone.", tags: ["in-the-moment", "stress"], is_sample: 1 },

  // ---- small groups ----
  { type: "small_group", title: "Men of Grace Recovery Group", subtitle: "New Hope Community Church", area: "Example — Grove City, PA", body: "Tuesdays, 7:00 PM · In-person", contact: "(555) 201-4488", is_sample: 1 },
  { type: "small_group", title: "Fresh Start Men's Circle", subtitle: "Cornerstone Fellowship", area: "Example — Pittsburgh, PA", body: "Thursdays, 6:30 PM · In-person", contact: "(555) 774-2201", is_sample: 1 },
  { type: "small_group", title: "Freedom Online Group", subtitle: "Multi-church partnership", area: "Example — Online / Nationwide", body: "Sundays, 8:00 PM (Zoom) · Online", contact: "(555) 990-1122", is_sample: 1 },

  // ---- accountability programs ----
  { type: "accountability_program", title: "Reclaim Accountability Partner Matching", body: "Pairs you with a trained, same-gender accountability partner for regular check-ins.", contact: "(555) 340-9981", is_sample: 1 },
  { type: "accountability_program", title: "Covenant Eyes-style Accountability Software", body: "Screen accountability software that sends activity reports to a partner you choose.", contact: "example-accountability.test", is_sample: 1 },

  // ---- counseling centers ----
  { type: "counseling_center", title: "Grace & Truth Counseling Center", subtitle: "Faith-based licensed counseling", area: "Example — Grove City, PA", contact: "(555) 412-8890", is_sample: 1 },
  { type: "counseling_center", title: "Pure Freedom Telehealth Counseling", subtitle: "Licensed counseling, addiction-informed, telehealth", area: "Example — Nationwide (telehealth)", contact: "(555) 665-3320", is_sample: 1 },
];

const SEED_BIBLE_PLANS = [
  {
    resource: { type: "bible_plan", title: "7 Days on Freedom from Shame", body: "A one-week reading plan working through what it means to be free from shame and condemnation.", tags: ["shame", "freedom"], is_sample: 1 },
    days: [
      { day_number: 1, reference: "Romans 8:1-2", reflection: "There is no condemnation. Start here, not at the end." },
      { day_number: 2, reference: "Psalm 32:3-5", reflection: "What happens when we stop hiding and confess honestly." },
      { day_number: 3, reference: "Genesis 3:8-10", reflection: "Shame's oldest move is hiding. Notice where you hide." },
      { day_number: 4, reference: "Luke 15:17-24", reflection: "The prodigal's return — grace runs toward you, not away." },
      { day_number: 5, reference: "2 Corinthians 5:17", reflection: "New creation, not a patched-up old one." },
      { day_number: 6, reference: "John 8:1-11", reflection: "Neither do I condemn you — go, and sin no more." },
      { day_number: 7, reference: "Zephaniah 3:17", reflection: "God rejoicing over you — not disappointed, rejoicing." },
    ],
  },
  {
    resource: { type: "bible_plan", title: "14 Days Building New Habits", body: "A two-week plan pairing scripture with practical reflection on replacing old patterns with new ones.", tags: ["growth", "perseverance"], is_sample: 1 },
    days: [
      { day_number: 1, reference: "Romans 12:2", reflection: "Renewing your mind is a process, not an event." },
      { day_number: 2, reference: "Philippians 4:8", reflection: "What you dwell on shapes what you do." },
      { day_number: 3, reference: "Galatians 5:16-17", reflection: "The pull of competing desires is real and named here." },
      { day_number: 4, reference: "1 Corinthians 6:12", reflection: "Not everything permissible is beneficial." },
      { day_number: 5, reference: "Hebrews 12:1-2", reflection: "Throw off what hinders — running the race with endurance." },
      { day_number: 6, reference: "Proverbs 4:23", reflection: "Guard your heart; it's the wellspring of everything else." },
      { day_number: 7, reference: "Psalm 1:1-3", reflection: "What you plant yourself near shapes what grows in you." },
      { day_number: 8, reference: "Ecclesiastes 4:9-10", reflection: "Two are better than one — the case for not doing this alone." },
      { day_number: 9, reference: "James 1:14-15", reflection: "How temptation actually develops, honestly described." },
      { day_number: 10, reference: "Matthew 26:41", reflection: "Watch and pray, so you won't fall into temptation." },
      { day_number: 11, reference: "1 Peter 5:8-9", reflection: "Staying alert without becoming anxious." },
      { day_number: 12, reference: "Isaiah 40:29-31", reflection: "Strength for the weary — this is who it's for." },
      { day_number: 13, reference: "Philippians 1:6", reflection: "He who began a good work will carry it to completion." },
      { day_number: 14, reference: "Psalm 40:1-3", reflection: "A new song, after the waiting — looking back at 14 days." },
    ],
  },
];

if (typeof module !== "undefined" && module.exports) {
  module.exports = { SEED_RESOURCES, SEED_BIBLE_PLANS };
}
