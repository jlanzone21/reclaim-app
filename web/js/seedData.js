/**
 * Seed content for the Reclaim resource database. Loaded into SQLite (via
 * sql.js) and kept in sync on every app start — see db.js's ensureSeeded()
 * and CURRENT_SEED_VERSION. Bump CURRENT_SEED_VERSION in db.js whenever
 * this file's content changes materially; ensureSeeded() replaces all
 * is_sample=1 rows on version bump without ever touching checkins or
 * user-added (is_sample=0) rows.
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
  { type: "scripture", title: "Ephesians 2:8-9", body: "For it is by grace you have been saved, through faith — and this is not from yourselves, it is the gift of God — not by works, so that no one can boast.", tags: ["grace", "identity", "shame"] },
  { type: "scripture", title: "Psalm 23:4", body: "Even though I walk through the darkest valley, I will fear no evil, for you are with me; your rod and your staff, they comfort me.", tags: ["loneliness", "hope", "struggle"] },
  { type: "scripture", title: "Philippians 4:6-7", body: "Do not be anxious about anything, but in every situation, by prayer and petition, with thanksgiving, present your requests to God. And the peace of God, which transcends all understanding, will guard your hearts and your minds in Christ Jesus.", tags: ["anxiety", "stress", "in-the-moment"] },
  { type: "scripture", title: "1 John 1:9", body: "If we confess our sins, he is faithful and just and will forgive us our sins and purify us from all unrighteousness.", tags: ["confession", "grace", "relapse"] },
  { type: "scripture", title: "Isaiah 41:10", body: "So do not fear, for I am with you; do not be dismayed, for I am your God. I will strengthen you and help you; I will uphold you with my righteous right hand.", tags: ["stress", "struggle", "hope"] },
  { type: "scripture", title: "Romans 12:2", body: "Do not conform to the pattern of this world, but be transformed by the renewing of your mind. Then you will be able to test and approve what God's will is — his good, pleasing and perfect will.", tags: ["growth", "renewal", "triggers"] },
  { type: "scripture", title: "Hebrews 4:15-16", body: "For we do not have a high priest who is unable to empathize with our weaknesses, but we have one who has been tempted in every way, just as we are — yet he did not sin. Let us then approach God's throne of grace with confidence, so that we may receive mercy and find grace to help us in our time of need.", tags: ["grace", "struggle", "temptation"] },
  { type: "scripture", title: "Psalm 51:10", body: "Create in me a pure heart, O God, and renew a steadfast spirit within me.", tags: ["renewal", "confession", "growth"] },

  // ---- sermons ----
  { type: "sermon", title: "Freedom from Shame", subtitle: "Example Pastor A. Reyes · Restored", url: "#", duration_min: 34, tags: ["shame", "freedom"], is_sample: 1 },
  { type: "sermon", title: "Walking in the Light", subtitle: "Example Pastor J. Whitfield · Honest Faith", url: "#", duration_min: 28, tags: ["honesty", "accountability"], is_sample: 1 },
  { type: "sermon", title: "You Are Not Your Worst Day", subtitle: "Example Pastor M. Osei · Identity in Christ", url: "#", duration_min: 41, tags: ["identity", "shame"], is_sample: 1 },
  { type: "sermon", title: "When Willpower Isn't Enough", subtitle: "Example Pastor R. Diaz · Grace Over Grit", url: "#", duration_min: 37, tags: ["struggle", "grace", "relapse"], is_sample: 1 },
  { type: "sermon", title: "The Power of Being Known", subtitle: "Example Pastor L. Kim · Community", url: "#", duration_min: 31, tags: ["community", "accountability", "loneliness"], is_sample: 1 },
  { type: "sermon", title: "Fighting for Purity", subtitle: "Example Pastor T. Brooks · Battle Ready", url: "#", duration_min: 39, tags: ["triggers", "temptation"], is_sample: 1 },
  { type: "sermon", title: "The Loneliness Trap", subtitle: "Example Pastor S. Nguyen · Better Together", url: "#", duration_min: 33, tags: ["loneliness", "community"], is_sample: 1 },
  { type: "sermon", title: "From Shame to Sonship", subtitle: "Example Pastor D. Coleman · Identity in Christ", url: "#", duration_min: 36, tags: ["shame", "identity"], is_sample: 1 },
  { type: "sermon", title: "Small Steps, Real Freedom", subtitle: "Example Pastor A. Reyes · Restored", url: "#", duration_min: 30, tags: ["perseverance", "growth"], is_sample: 1 },
  { type: "sermon", title: "What Grace Actually Means", subtitle: "Example Pastor J. Whitfield · Honest Faith", url: "#", duration_min: 27, tags: ["grace", "relapse"], is_sample: 1 },

  // ---- articles ----
  { type: "article", title: "Understanding the Brain Science of Pornography Addiction", subtitle: "Example author: Dr. S. Patton", body: "A plain-language look at how compulsive pornography use affects the brain's reward pathways, and why willpower alone often isn't enough to break the cycle.", url: "#", tags: ["struggle", "education"], is_sample: 1 },
  { type: "article", title: "How to Talk to Your Spouse About This Struggle", subtitle: "Example author: C. Bennett, LMFT", body: "Practical guidance for having an honest, non-defensive conversation with a spouse or partner about pornography use — timing, wording, and what to expect.", url: "#", tags: ["community", "honesty", "relationships"], is_sample: 1 },
  { type: "article", title: "Why Accountability Partners Work", subtitle: "Example author: Reclaim Editorial", body: "The research and reasoning behind why regular check-ins with another person measurably improve recovery outcomes.", url: "#", tags: ["accountability", "community"], is_sample: 1 },
  { type: "article", title: "Recognizing Your Triggers", subtitle: "Example author: Reclaim Editorial", body: "A guide to identifying the emotional states, times of day, and situations that most often precede a slip — the first step toward interrupting the pattern.", url: "#", tags: ["struggle", "triggers", "relapse"], is_sample: 1 },
  { type: "article", title: "The Role of Community in Recovery", subtitle: "Example author: Reclaim Editorial", body: "Why isolation is one of the strongest predictors of relapse, and what meaningfully re-engaging with community can look like in practice.", url: "#", tags: ["community", "loneliness"], is_sample: 1 },
  { type: "article", title: "What the Research Says About Recovery Rates", subtitle: "Example author: Dr. S. Patton", body: "An honest look at what studies actually show about relapse and long-term recovery — and why consistent support structures change the odds more than any single tactic.", url: "#", tags: ["struggle", "education", "hope"], is_sample: 1 },
  { type: "article", title: "Setting Up Accountability Software the Right Way", subtitle: "Example author: Reclaim Editorial", body: "A practical walkthrough of configuring screen accountability tools so they actually get used — who should receive reports, how often, and how to talk about it upfront.", url: "#", tags: ["accountability", "triggers"], is_sample: 1 },
  { type: "article", title: "Talking to Your Kids About This (When They're Old Enough)", subtitle: "Example author: C. Bennett, LMFT", body: "Age-appropriate guidance for parents who want to have an honest, non-shaming conversation with older kids or teens about pornography.", url: "#", tags: ["community", "honesty"], is_sample: 1 },
  { type: "article", title: "When Your Spouse Found Out: A Guide for the First 48 Hours", subtitle: "Example author: C. Bennett, LMFT", body: "What to do and not do in the immediate aftermath of disclosure — for both partners — while bigger conversations and counseling get scheduled.", url: "#", tags: ["community", "honesty", "relationships"], is_sample: 1 },
  { type: "article", title: "Boredom, Stress, and the Brain's Reward Loop", subtitle: "Example author: Dr. S. Patton", body: "Why boredom and stress are two of the most common relapse triggers, and what's actually happening neurologically when they show up.", url: "#", tags: ["triggers", "stress", "education"], is_sample: 1 },

  // ---- devotionals ----
  { type: "devotional", title: "Today's Battle Isn't Yours Alone", body: "A short reflection on 1 Corinthians 10:13 — that every temptation comes with a way out, even when it doesn't feel like it in the moment.", tags: ["temptation", "hope"], is_sample: 1 },
  { type: "devotional", title: "When Shame Lies to You", body: "Shame tells you to hide. Grace says come closer. A short reflection on Romans 8:1 and what it means to stop hiding.", tags: ["shame", "grace"], is_sample: 1 },
  { type: "devotional", title: "Small Steps, Real Change", body: "Recovery rarely looks like a single dramatic moment — it looks like a thousand small, boring, faithful choices. A reflection on perseverance.", tags: ["perseverance", "growth"], is_sample: 1 },
  { type: "devotional", title: "The God Who Sees You", body: "A short reflection on being fully known and fully loved anyway, drawing on the story of Hagar in Genesis 16.", tags: ["identity", "shame"], is_sample: 1 },
  { type: "devotional", title: "Grace for the Relapse", body: "A slip is not the end of the story. A reflection on Lamentations 3:22-23 — new mercies, every morning, including this one.", tags: ["relapse", "grace", "hope"], is_sample: 1 },
  { type: "devotional", title: "Today You Get to Choose Again", body: "Yesterday doesn't get a vote in today. A short reflection on starting fresh without pretending the past didn't happen.", tags: ["perseverance", "hope"], is_sample: 1 },
  { type: "devotional", title: "The Loneliness Lie", body: "Isolation tells you no one would understand. A reflection on why that's almost never true, and what one honest conversation can do.", tags: ["loneliness", "community"], is_sample: 1 },
  { type: "devotional", title: "Grace Isn't a Loophole", body: "Grace isn't permission to keep drifting — it's the strength to actually change. A short reflection on Hebrews 4:16.", tags: ["grace", "accountability"], is_sample: 1 },
  { type: "devotional", title: "You Are Not Behind", body: "There's no finish line you're late to. A reflection on why comparing your recovery timeline to anyone else's misses the point.", tags: ["growth", "relapse"], is_sample: 1 },
  { type: "devotional", title: "Held, Not Hunted", body: "Anxiety can make God's attention feel like scrutiny. A short reflection on Psalm 23 — being watched over, not watched for failure.", tags: ["anxiety", "identity"], is_sample: 1 },

  // ---- coping mechanisms ----
  { type: "coping_mechanism", title: "Urge Surfing", body: "Urges peak and fade, usually within 15-20 minutes, whether or not you act on them. Instead of fighting the urge, try noticing it like a wave: name it, sit with it, and let it crest and pass without acting.", tags: ["temptation", "in-the-moment"], is_sample: 1 },
  { type: "coping_mechanism", title: "The HALT Check", body: "Before reacting to an urge, ask: am I Hungry, Angry, Lonely, or Tired? Urges are often a stand-in for one of these unmet needs. Naming the real need can point you to the real fix.", tags: ["triggers", "in-the-moment"], is_sample: 1 },
  { type: "coping_mechanism", title: "Change Your Environment", body: "Physically move — leave the room, go outside, go where other people are. Removing yourself from the location tied to the urge breaks the pattern more reliably than trying to white-knuckle it in place.", tags: ["in-the-moment", "triggers"], is_sample: 1 },
  { type: "coping_mechanism", title: "Reach Out Immediately", body: "Text or call your accountability partner the moment you notice an urge, not after. Saying it out loud to another person changes the moment.", tags: ["accountability", "in-the-moment"], is_sample: 1 },
  { type: "coping_mechanism", title: "5-4-3-2-1 Grounding", body: "Name 5 things you can see, 4 you can touch, 3 you can hear, 2 you can smell, 1 you can taste. A simple sensory grounding technique to interrupt an escalating moment.", tags: ["in-the-moment", "anxiety"], is_sample: 1 },
  { type: "coping_mechanism", title: "Move Your Body", body: "A short walk, push-ups, or any physical exertion changes your physiological state and can interrupt an urge cycle faster than willpower alone.", tags: ["in-the-moment", "stress"], is_sample: 1 },
  { type: "coping_mechanism", title: "Cold Water Reset", body: "Splash cold water on your face or hold an ice cube for 30 seconds. The physical shock is a genuine physiological pattern interrupt, not just a distraction trick.", tags: ["in-the-moment", "stress"], is_sample: 1 },
  { type: "coping_mechanism", title: "Have a Reach-Out Script Ready", body: "Write out a short text to your accountability partner in advance — something like \"Having an urge, could use a check-in\" — so you don't have to compose a message in the hardest moment. Save it as a note you can copy-paste.", tags: ["accountability", "in-the-moment"], is_sample: 1 },
  { type: "coping_mechanism", title: "The 10-Minute Rule", body: "Commit to waiting just 10 minutes before acting on the urge — no other rules. Urges are time-limited, and a 10-minute delay is often enough for the intensity to drop and your judgment to come back online.", tags: ["in-the-moment", "temptation"], is_sample: 1 },
  { type: "coping_mechanism", title: "Shift What You're Hearing", body: "Put on music, a podcast, or worship that pulls your attention elsewhere. Changing your auditory environment is a fast, low-effort way to break focus on the urge.", tags: ["in-the-moment", "triggers"], is_sample: 1 },
  { type: "coping_mechanism", title: "Anchor Verse", body: "Memorize one short verse ahead of time and say it out loud when an urge hits — 1 Corinthians 10:13 works well for this. Having it ready beats trying to think of something in the moment.", tags: ["in-the-moment", "temptation"], is_sample: 1 },
  { type: "coping_mechanism", title: "Write Down What Led Here", body: "Right when you notice the urge — before or after acting on it — jot down what happened in the hour before: mood, place, what you were avoiding. Patterns are much easier to see on paper than in memory.", tags: ["triggers", "growth"], is_sample: 1 },

  // No small_group rows here anymore: real groups now live in Supabase (see
  // ResourceRepo.getSmallGroups and scripts/import-small-groups.mjs), read live, not seeded locally.

  // No accountability_program rows here anymore: the "Accountability partner" tool now checks
  // UserPreferencesStore directly (the person's real partner, or a prompt to add one) instead of
  // a generic sample program list -- see PURPOSE.md.

  // ---- counseling centers ----
  { type: "counseling_center", title: "Grace & Truth Counseling Center", subtitle: "Faith-based licensed counseling", area: "Example — Grove City, PA", contact: "(555) 412-8890", is_sample: 1 },
  { type: "counseling_center", title: "Pure Freedom Telehealth Counseling", subtitle: "Licensed counseling, addiction-informed, telehealth", area: "Example — Nationwide (telehealth)", contact: "(555) 665-3320", is_sample: 1 },
  { type: "counseling_center", title: "Renewal Family Counseling", subtitle: "Licensed counseling, individual and couples", area: "Example — Columbus, OH", contact: "(555) 704-2298", is_sample: 1 },
  { type: "counseling_center", title: "Overcomers Telehealth Group Therapy", subtitle: "Licensed group therapy, addiction-focused, telehealth", area: "Example — Nationwide (telehealth)", contact: "(555) 833-5561", is_sample: 1 },
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
  {
    resource: { type: "bible_plan", title: "10 Days on Identity in Christ", body: "A ten-day plan for untangling who you are from what you've done — working through identity, not just behavior.", tags: ["identity", "shame", "grace"], is_sample: 1 },
    days: [
      { day_number: 1, reference: "Genesis 1:27", reflection: "Made in the image of God — before any of this happened." },
      { day_number: 2, reference: "Ephesians 2:8-9", reflection: "A gift, not a performance you're being graded on." },
      { day_number: 3, reference: "1 Peter 2:9", reflection: "Chosen, not merely tolerated." },
      { day_number: 4, reference: "Romans 8:38-39", reflection: "Nothing separates you from this love — read the whole list." },
      { day_number: 5, reference: "Galatians 2:20", reflection: "A new center of identity, not a self-improvement project." },
      { day_number: 6, reference: "Colossians 3:1-3", reflection: "Your life is hidden — safe — not exposed and disqualified." },
      { day_number: 7, reference: "2 Corinthians 5:17", reflection: "Revisit this one. Let it actually land this time." },
      { day_number: 8, reference: "Psalm 139:13-14", reflection: "Fearfully and wonderfully made — including the parts you're hardest on." },
      { day_number: 9, reference: "1 John 3:1", reflection: "Called children of God. Not almost. Not on probation." },
      { day_number: 10, reference: "Philippians 3:12-14", reflection: "Pressing on — identity settled, growth still ongoing." },
    ],
  },
  {
    resource: { type: "bible_plan", title: "5 Days When You've Just Slipped", body: "A short plan for right after a slip — not to dwell on failure, but to get grounded again quickly and take the next honest step.", tags: ["relapse", "grace", "hope"], is_sample: 1 },
    days: [
      { day_number: 1, reference: "1 John 1:9", reflection: "Confess it plainly. No decoration, no minimizing." },
      { day_number: 2, reference: "Lamentations 3:22-23", reflection: "New mercy this morning — today counts as a fresh one." },
      { day_number: 3, reference: "Psalm 51:10-12", reflection: "Ask for a clean heart, not just less guilt." },
      { day_number: 4, reference: "James 5:16", reflection: "Tell someone. Today, not eventually." },
      { day_number: 5, reference: "Isaiah 43:18-19", reflection: "Forget the former things — a new thing is starting, right now." },
    ],
  },
];

if (typeof module !== "undefined" && module.exports) {
  module.exports = { SEED_RESOURCES, SEED_BIBLE_PLANS };
}
