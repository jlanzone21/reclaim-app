// Resource tools, prompts, and the crisis check shared by ReclaimAgent (on-device AI) and ResourcesAgent (Basic mode).
// Tool names and output shapes match ResourcesAgent's, so app.js renders both agents' results the same way.

// Resources are picked by weighted keyword scoring, not by asking the model (a model-based pick cost ~16 s per message on a
// phone). Each resource has `signals`: [pattern, weight] pairs run against the lowercased message. Weights add up once per
// matching pattern: 4-5 = an explicit ask for that thing, 3 = a clear phrasing of it, 1-2 = supporting hints. Negative weights
// cancel false alarms ("are you a counselor?" is a question about the AI, not a request for one). Every resource scoring at
// least AGENT_MIN_SCORE counts as an explicit ask; resourcePicker.js turns those, plus any named feeling, into the reply's
// cards (up to 3 kinds) using what the person has rated helpful.
const AGENT_MIN_SCORE = 3;

// Books whose names can't be mistaken for a word or a name, so "romans 8" alone counts as a reference.
const AGENT_BOOK_UNIQUE = "genesis|exodus|leviticus|deuteronomy|joshua|psalms?|proverbs|ecclesiastes|isaiah|jeremiah|lamentations|ezekiel|matthew|romans|corinthians|galatians|ephesians|philippians|colossians|thessalonians|hebrews|revelation";
const AGENT_BOOK_ANY = `${AGENT_BOOK_UNIQUE}|numbers|judges|ruth|samuel|kings|chronicles|ezra|nehemiah|esther|job|song of solomon|daniel|hosea|joel|amos|obadiah|jonah|micah|nahum|habakkuk|zephaniah|haggai|zechariah|malachi|mark|luke|john|acts|timothy|titus|philemon|james|peter|jude`;

const AGENT_TOOL_DEFS = [
  {
    name: "bible_plan_finder",
    intro: "I found some Bible reading plans you could start.",
    signals: [
      [/\b(bible|reading|devotional|study|scripture) plans?\b/, 5],
      [/\bplans? (for|to|on|about) (read\w*|study\w*|go(ing)? through)\b/, 4],
      [/\b(\d+|seven|ten|fourteen|thirty|forty)[ -]?days?( bible| reading)? plan\b|\bplan for \d+ days?\b/, 4],
      [/\bread (through |the )?(the )?bible\b|\bread(ing)? the bible daily\b|\bwhere (do|should) i start (reading|with the bible)\b/, 3],
      [/\bwhat (should|do) i read (this|next|today|tomorrow)\b/, 3],
      [/\bbible study\b/, 3],
      [/\b(do you have|got|any|is there) (a |an )?(\w+ )?plans?\b/, 2],
      [/\bplan\b/, 1],
    ],
  },
  {
    name: "scripture_search",
    intro: "I found a verse{about} for you.",
    themed: true,
    signals: [
      [/\b(verses?|scriptures?|passages?|psalms?)\b/, 3],
      [new RegExp(`\\b(?:[1-3]\\s?)?(?:${AGENT_BOOK_ANY})\\s\\d{1,3}:\\d{1,3}`), 4],
      [new RegExp(`\\b(?:[1-3]\\s?)?(?:${AGENT_BOOK_UNIQUE})\\s(?:chapter\\s)?\\d{1,3}\\b`), 4],
      [/\bwhat does (the bible|god|scripture|jesus|paul) say\b|\b(the bible|god|scripture|jesus) (says?|said) (about|on)\b/, 3],
      [/\b(quote|recite|write out|read me|share|show me) (me )?(a |the |some )?(bible|scripture|word of god)\b/, 3],
      [/\bbible\b/, 1],
    ],
  },
  {
    name: "devotional_finder",
    intro: "I found a short devotional{about} for you.",
    themed: true,
    signals: [
      [/\bdevotions?\b|\bdevotionals?\b/, 4],
      [/\b(something|anything|a thought|a reading) to (reflect|meditate|ponder) (on|upon)\b|\breflect on\b|\bsomething to reflect\b/, 3],
      [/\bquiet time\b|\b(morning|evening|daily|short) (reading|reflection|meditation)\b/, 3],
      [/\bsomething to read (this|tonight|today|in the)\b/, 3],
    ],
  },
  {
    name: "sermon_library",
    intro: "I found some sermons you might find helpful.",
    signals: [
      [/\b(sermons?|preach\w*|homil\w*)\b/, 4],
      [/\b(teaching|teachings|message|messages|talk|lesson) (on|about)\b/, 3],
      [/\b(good|any|some) (teaching|preaching|messages?)\b/, 3],
      [/\b(listen|watch|hear)\b.*\b(pastor|preacher|message|teaching)\b|\b(pastor|preacher) (talk|teach|speak|preach)\w*/, 3],
    ],
  },
  {
    name: "article_finder",
    intro: "I found some articles that might help.",
    signals: [
      [/\b(articles?|blogs?|blog posts?)\b/, 4],
      [/\bpodcasts? (about|on|for)\b/, 3],
      [/\bpodcasts?\b/, 1],
      [/\b(books?|reading|resources?|information|info|something to read) (on|about|for)\b|\bread (more )?(about|on)\b|\bsomething to read\b/, 3],
      [/\bresources? for (wives|husbands|spouses|parents|teens|women|men|pastors|families)\b/, 4],
      [/\b(anything|something|stuff) (on|about) (how|why)\b/, 3],
      [/\bhow (does|do|did|the) (the )?(brain|porn|addiction)\b.*\b(work|addict\w*|affect\w*)\b/, 3],
    ],
  },
  {
    name: "counseling_directory",
    intro: "I found some counselors you could reach out to.",
    signals: [
      [/\b(counsel\w*|therap\w*|psycholog\w*|psychiatr\w*)\b/, 3],
      [/\b(find|need|want|see|get|seek|looking for|recommend|refer|talk to|know (of )?any|near me)\b.*\b(counsel\w*|therap\w*)\b/, 2],
      [/\bprofessional (help|support)\b|\btreatment\b|\brehab\b|\brecovery program\b/, 3],
      [/\b(see|talk to|speak (to|with)|meet with) (a |an )?(professional|specialist|doctor)\b/, 3],
      // Questions about the AI, not requests for a counselor.
      [/\bare you (a |an |my |the )?(counsel\w*|therap\w*)\b|\binstead of (a |my )?(counsel\w*|therap\w*)\b|\b(replace|substitute for) (a |my )?(counsel\w*|therap\w*)\b/, -6],
    ],
  },
  {
    name: "small_group_finder",
    intro: "I found some recovery groups you could look into.",
    signals: [
      [/\bgroups?\b/, 3],
      [/\bgroup (chat|text|message|project|photo|fitness|call|order)\b/, -4],
      [/\b(support|recovery|men'?s|women'?s|online|small|church|bible study|accountability) groups?\b/, 2],
      [/\b(celebrate recovery|12[- ]step|twelve[- ]step|\bsaa\b|\bna meeting|support meeting|meeting near)\b/, 4],
      [/\bcommunity\b|\bfellowship\b/, 2],
      [/\bcommunity of (believers|guys|men|women|christians|people)\b|\bfellow believers\b/, 3],
      [/\b(people|guys|men|women|others) who (get it|understand|struggle|are going through)\b/, 3],
      [/\b(join|find|looking for) (a |an |some )?(community|fellowship|support)\b/, 2],
    ],
  },
  {
    name: "accountability_match",
    intro: "Let's look at your accountability partner.",
    signals: [
      [/\baccountab\w*/, 4],
      [/\bcheck(ing)? in (on|with) me\b|\bhold me (accountable|responsible)\b|\bkeep me (honest|on track|accountable)\b|\bwalk with me\b/, 4],
      [/\b(a |some )?(mentor|spiritual director)\b/, 3],
      [/\bwho (should|can|could|do) i tell\b|\bneed (a |some )?(person|someone|somebody) (to talk to|to tell|to lean on|real)\b|\bneed a (real )?person\b/, 3],
      [/\bsomeone (to |who can )?(talk|check|help|support|walk|pray)\b/, 2],
    ],
  },
  {
    name: "coping_toolkit",
    intro: "Here are a few things that can help right now.",
    themed: true,
    signals: [
      [/\b(urges?|crav\w*|tempt\w*|coping|in the moment)\b/, 3],
      [/\babout to (look|watch|give in|relapse|slip|act out)\b|\b(want|going) to (look|watch)\b/, 4],
      [/\bsomething (else )?to do (instead|right now|now)\b|\bsomething (quick|simple|small|easy) (i can |to )?do\b|\bdistract\w*/, 4],
      [/\bget through (the|this|tonight|the night|the day|the urge|the moment)\b|\bride (it|this) out\b/, 3],
      [/\b(breathing|grounding) (exercise|technique)s?\b|\bcalm (down|myself)\b/, 4],
      [/\bcoping (skills?|techniques?|tips?|strateg\w*)\b/, 4],
      [/\bplan for when (i|it)\b|\bwhat (do|should) i do (when|if|right now)\b/, 4],
      [/\b(healthy|better|other|good) (things|ways|alternatives|outlets)\b|\bthings to do instead\b/, 3],
      [/\bhow (do|can|should) i (stop|resist|fight|beat|break|get past)\b.*\b(urge|craving|temptation|cycle|habit)\b|\bbreak the cycle\b|\bresist\b/, 3],
    ],
  },
];

// Keyword → theme, checked in order. Themes are the tags used in seedData.js.
const AGENT_THEME_WORDS = [
  ["shame", /\b(shame\w*|ashamed|guilt\w*|disgust\w*|dirty|worthless)\b/],
  ["temptation", /\btempt\w*/],
  ["loneliness", /\b(lonel\w*|alone|isolat\w*)\b/],
  ["anxiety", /\b(anxi\w*|worr\w*|panic\w*|afraid|scared)\b/],
  ["stress", /\b(stress\w*|overwhelm\w*|pressure)\b/],
  ["hope", /\b(hope\w*|despair\w*)\b/],
  ["relapse", /\b(relaps\w*|slip\w*|fail\w*)\b/],
  ["grace", /\b(grace|forgiv\w*|mercy)\b/],
  ["identity", /\b(identity|who i am)\b/],
  ["freedom", /\bfree(dom)?\b/],
  ["perseverance", /\b(persever\w*|keep going|give up|endur\w*)\b/],
  ["accountability", /\baccountab\w*/],
  ["community", /\b(community|church|friends?)\b/],
  ["triggers", /\btrigger\w*/],
  ["growth", /\bgrow\w*/],
  ["struggle", /\bstruggl\w*/],
];

const AGENT_AFFIRMATIVE = /^\s*(yes|yeah|yep|yup|sure|ok(ay)?|please|that would help|i'?d like that)\b/i;

function agentInferTheme(lower) {
  const hit = AGENT_THEME_WORDS.find(([, re]) => re.test(lower));
  return hit ? hit[0] : null;
}

// Sum of the weights of every signal that matches. A separate function so the router can be tested offline against
// labeled prompts without running the model (scripts/test-resource-picker.mjs).
function agentScoreTool(tool, lower) {
  return tool.signals.reduce((sum, [re, weight]) => sum + (re.test(lower) ? weight : 0), 0);
}

// Which kinds of resource a message gets (several now, plus what the person has rated helpful) is
// decided by ResourcePicker.pick (resourcePicker.js), built on the scoring above. It keeps the old
// single-pick rules: a short "yes" is matched against the last reply, "are you ...?" questions get
// no card, and a named feeling with no explicit ask still gets a resource -- a verse by default,
// per the user's framing that pointing to scripture should be one of the AI's first responses.

const AGENT_SYSTEM_PROMPT = `You are an unnamed AI resource finder for the app Reclaim 128. You help someone fighting pornography use, from a Christian perspective, find resources: Bible verses, devotionals, Bible reading plans, articles, sermons, coping tools, small groups, accountability partners, and counselors. You never replace real people like a pastor, counselor, accountability partner, friend, or small group, and you never tell someone they don't need them.

Reply in 1 or 2 short, plain sentences.
- You are not a chat companion and you do not answer questions. Never give advice, explanations, opinions, teaching, or theology: you are too unreliable at them. If someone asks a question, don't answer it. Say in one sentence that you can only help them find resources, and name one kind of resource that fits what they said.
- The app finds and shows the resources itself and introduces them with one short sentence of its own. Never claim you found or are showing something yourself, and never quote, name, or list a specific verse, book, article, sermon, group, counselor, or person.
- If they are hurting, give one short, warm acknowledgement without advice, and point them toward a real person in their life (use their accountability partner's or pastor's name when you know it).
- No therapy, diagnosis, or medical advice.
- You may gently use what you're told about their check-ins and setup answers. Never recite it back as a list.
- If they sound hopeless or mention or imply suicidal thoughts, mention the 988 Lifeline is free by call or text, anytime.
- If a message has nothing to do with their life, faith, recovery, or finding resources, don't answer it. Kindly say in one sentence that you're only here for those.`;

// async because small_group_finder/sermon_library/article_finder/counseling_directory all read
// live from Supabase now (see ResourceRepo) -- every other branch below still resolves
// synchronously, `await`ing a non-promise is a no-op.
// `options` ({ limit, rank, verseTopic }) comes only from the on-device AI agent: `limit` is this
// tool's share of a multi-type reply's item budget, `rank` orders candidates by the person's learned
// preferences (resourcePicker.js), and `verseTopic` is a meaning-based verse topic decision (see
// agentFindVerse). Basic mode never passes it, so its results are exactly what they were.
async function executeAgentTool(name, input, options = {}) {
  const theme = input && input.theme ? input.theme : null;
  const { limit, rank, verseTopic } = options;
  switch (name) {
    case "scripture_search":
      return agentFindVerse(theme, input && input.query ? input.query : null, rank, verseTopic);
    case "devotional_finder":
      return ResourceRepo.getDevotional(theme, rank);
    case "bible_plan_finder":
      return { plans: ResourceRepo.getBiblePlans(limit, rank) };
    case "article_finder":
      return { articles: await ResourceRepo.getArticles({ limit, rank }) };
    case "coping_toolkit":
      return { mechanisms: ResourceRepo.getCopingMechanisms(theme, limit, rank) };
    case "small_group_finder":
      return { groups: await ResourceRepo.getSmallGroups(input && input.query, limit, rank) };
    case "accountability_match": {
      // Deterministic, not model-dependent: this is real personal data (or the deliberate
      // absence of it), never a generic sample list -- see PURPOSE.md. Up to 2 partners.
      const prefs = UserPreferencesStore.get();
      const contacts = [
        { name: prefs.accountability_name, phone: prefs.accountability_phone },
        { name: prefs.accountability_name_2, phone: prefs.accountability_phone_2 },
      ].filter((c) => c.name && c.phone);
      return { contacts };
    }
    case "sermon_library":
      return { sermons: await ResourceRepo.getSermons({ limit, rank }) };
    case "counseling_directory":
      return { centers: await ResourceRepo.getCounselingCenters({ limit, rank }) };
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// Deterministic word-overlap scoring against the 100 topics in verse_topics (see db.js, imported
// from bible_verses_for_100_circumstances.csv) -- same philosophy as agentScoreTool above: plain
// keyword matching, not embeddings/ML. A short stopword list keeps generic words (the, feel, god,
// verse...) from padding every topic's score equally and drowning out the real signal.
const VERSE_TOPIC_STOPWORDS = new Set([
  "the", "a", "an", "to", "of", "in", "on", "for", "and", "or", "i", "im", "i'm", "feel", "feeling",
  "feelings", "feels", "about", "with", "my", "me", "is", "are", "am", "so", "really", "very",
  "just", "like", "what", "do", "does", "god", "bible", "verse", "verses", "find", "something",
  "need", "want", "right", "now", "can", "you", "it", "that", "this",
]);

function verseTopicWords(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9'\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !VERSE_TOPIC_STOPWORDS.has(w));
}

// A handful of common irregular pairs wordsMatch's prefix rule can't catch on its own (the words
// diverge too early to share a 4-letter prefix -- "angry"/"anger" share only "ang"). Deliberately
// short: real irregulars worth having, not an attempt at a full synonym dictionary.
const VERSE_TOPIC_SYNONYMS = {
  angry: "anger", mad: "anger",
  sad: "sadness", sorrow: "sadness", sorrowful: "sadness",
  scared: "fear", afraid: "fear", terrified: "fear",
};

// Two words count as the same for matching purposes if they're identical, or if they share a
// long-enough common prefix and whichever one is shorter is almost entirely that prefix (just a
// short suffix/ending differs) -- catches ordinary inflection ("stressed"/"stress",
// "anxious"/"anxiety", "lonely"/"loneliness") without a real stemmer or synonym list. A plain
// startsWith check alone misses "anxious"/"anxiety": they share the prefix "anxi" but neither
// fully contains the other, since "-ous" and "-ety" are both real suffixes, not substrings of one
// another.
function wordsMatch(a, b) {
  if (a === b) return true;
  if (a.length <= 3 || b.length <= 3) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i < 4) return false;
  return Math.min(a.length, b.length) - i <= 3;
}

function matchVerseTopic(userText) {
  const userWords = verseTopicWords(userText).map((w) => VERSE_TOPIC_SYNONYMS[w] || w);
  if (!userWords.length) return null;
  const rows = typeof ResourceRepo !== "undefined" ? ResourceRepo.getVerseTopics() : [];
  if (!rows || !rows.length) return null;

  let best = null;
  let bestScore = 0;
  for (const row of rows) {
    const topicWords = verseTopicWords(row.topic);
    let score = 0;
    for (const tw of topicWords) {
      if (userWords.some((uw) => wordsMatch(uw, tw))) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }
  return bestScore >= 1 ? best : null; // require at least one real word match, not just a coincidental partial
}

// One reference at random from a topic row's semicolon-separated list -- varies which verse
// comes back for the same topic across conversations, same spirit as randomByTheme (resourceRepo.js).
function verseTopicReference(row) {
  if (!row) return null;
  const refs = row.refs.split(";").map((r) => r.trim()).filter(Boolean);
  if (!refs.length) return null;
  return { topic: row.topic, reference: refs[Math.floor(Math.random() * refs.length)] };
}

function pickVerseTopicReference(userText) {
  return verseTopicReference(matchVerseTopic(userText));
}

// Every verse Chat shows goes through the YouVersion Bible display (youversion.js, rendered by
// app.js renderToolResult). `query` (the raw message, when available) is checked against the
// 100-topic list first -- the closest real-circumstance match wins and is resolved live through
// YouVersion by reference. Failing that: a detected theme keeps its hand-picked verse from
// seedData.js, just fetched from YouVersion. A plain "share a verse" (no theme, no topic) gets a
// seeded verse on the gospel / God's grace (VERSE_DEFAULT_THEME) -- not YouVersion's Verse of the
// Day, which it used to return: Home already shows that one (Nathaniel, 2026-10-07). No app key /
// offline / API error -> the local verse, as before -- this is why the topic match is tried first
// but never replaces that fallback chain, only sits in front of it.
//
// `verseTopic` comes from the AI agent when the embedding model is loaded: a topic matched by
// meaning ({ topic, refs }), or null for "no topic" -- it then replaces the word-overlap match,
// which fired on single generic words ("help" -> "Helping someone who is struggling"). Left
// undefined (Basic mode, or no embedding model), the word-overlap match runs as before.
const VERSE_DEFAULT_THEME = "grace";

async function agentFindVerse(theme, query, rank, verseTopic) {
  const topicPick = verseTopic === undefined ? pickVerseTopicReference(query) : verseTopicReference(verseTopic);
  if (topicPick && typeof YouVersion !== "undefined" && YouVersion.available()) {
    const display = await YouVersion.getVerse(topicPick.reference);
    // topic: what a thumbs up/down on this verse teaches (resourceFeedback.js).
    if (display) return { title: display.reference, body: null, youversion: display, topic: topicPick.topic };
  }

  // graceDefault: the intro says "a verse about God's grace" instead of naming no theme.
  const graceDefault = !theme;
  const local = ResourceRepo.getScripture(theme || VERSE_DEFAULT_THEME, rank);
  if (!local) return null;
  if (typeof YouVersion === "undefined" || !YouVersion.available()) return { ...local, graceDefault };
  const display = await YouVersion.getVerse(local.title);
  if (!display) return { ...local, graceDefault };
  return { ...local, title: display.reference, youversion: display, graceDefault };
}

function agentStreamText(text, onTextDelta) {
  return (async () => {
    const words = text.split(/(\s+)/);
    for (const word of words) {
      onTextDelta(word);
      await new Promise((r) => setTimeout(r, 16 + Math.random() * 30));
    }
  })();
}

function agentIsCrisis(text) {
  return CRISIS_PATTERNS.some((pattern) => pattern.test(text));
}
