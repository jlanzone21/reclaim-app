// Resource tools, prompts, and the crisis check shared by ReclaimAgent (on-device AI) and ResourcesAgent (Basic mode).
// Tool names and output shapes match ResourcesAgent's, so app.js renders both agents' results the same way.

// Resources are picked by weighted keyword scoring, not by asking the model (a model-based pick cost ~16 s per message on a
// phone). Each resource has `signals`: [pattern, weight] pairs run against the lowercased message. Weights add up once per
// matching pattern: 4-5 = an explicit ask for that thing, 3 = a clear phrasing of it, 1-2 = supporting hints. Negative weights
// cancel false alarms ("are you a counselor?" is a question about the AI, not a request for one). The highest score wins if it
// reaches AGENT_MIN_SCORE; ties go to the earlier entry. Only an explicit ask or an urge happening now shows a card:
// someone sharing a slip or a feeling gets a reply, not a resource they didn't ask for.
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

// Sum of the weights of every signal that matches. A separate function (not inlined in agentPickResource) so the router
// can be tested offline against labeled prompts without running the model.
function agentScoreTool(tool, lower) {
  return tool.signals.reduce((sum, [re, weight]) => sum + (re.test(lower) ? weight : 0), 0);
}

function agentTopTool(lower) {
  let best = null;
  let bestScore = 0;
  for (const tool of AGENT_TOOL_DEFS) {
    const score = agentScoreTool(tool, lower);
    if (score > bestScore) {
      best = tool;
      bestScore = score;
    }
  }
  return bestScore >= AGENT_MIN_SCORE ? best : null;
}

// A short "yes" answers whatever the last reply offered ("Would a verse on grace help?"), so it's matched against that reply instead.
function agentPickResource(userText, lastReply = "") {
  let lower = userText.toLowerCase();
  if (AGENT_AFFIRMATIVE.test(userText) && userText.length < 40 && lastReply) lower = lastReply.toLowerCase();
  const tool = agentTopTool(lower);
  if (tool) {
    const theme = tool.themed ? agentInferTheme(lower) || (tool.name === "coping_toolkit" ? "in-the-moment" : null) : null;
    return { resource: tool.name, theme };
  }
  // Nothing explicitly asked for, but they named a feeling (AGENT_THEME_WORDS) -- default to a
  // verse for it rather than staying silent on resources. User's own framing: pointing to
  // scripture should be one of the AI's first responses, not only shown when someone thinks to
  // ask for one by name.
  if (/\bare you\b/.test(lower)) return null;
  const theme = agentInferTheme(lower);
  return theme ? { resource: "scripture_search", theme } : null;
}

const AGENT_SYSTEM_PROMPT = `You are an unnamed ai chat bot for the app Reclaim 128. You talk with someone fighting pornography addiction from a Christian perspective. You never replace real people like a pastor, counselor, accountability partner, friend, or small group. You respond kindly and clearly, but never act as a real companion. If asked who or what you are, say you're an AI chat bot for Reclaim 128 (not a person) and point them toward real people. Never tell them they don't need a pastor, counselor, accountability partner, or group. Your primary goal is to point the user to helpful and valuable resources.

Reply in 1 to 3 short plain sentences.
- Scripture is central to how you respond — not just one resource among many. The app shows verses in the YouVersion Bible display: today's verse from YouVersion when they just ask for a verse, or one picked for what they're facing. If the app hasn't already shown them a verse this turn, and they sound discouraged, ashamed, anxious, or like they're struggling, lean toward bringing God's word into what you say, or asking if they'd like a verse for it, more often than not. Never quote, name, or list a verse yourself — the app shows the actual verse in the YouVersion display; you just point toward it (e.g. "would today's verse help?").
- Never let them dwell in shame, and never blame them or call them broken. Point to God's grace and forgiveness, and encourage them to bring their shame to God in prayer.
- Encourage real human contact: confessing to a trusted friend, especially if they've kept it hidden, or reaching out to their accountability partner, pastor, or group today. If their setup answers name an accountability partner or pastor, encourage reaching out to that person by name (e.g. "have you talked to [[name of partner]] about this?") instead of the generic phrase — that's the whole reason they told you. If they haven't named anyone, just say "a trusted friend, your pastor, or a group", and never write a bracketed placeholder. Pick what fits the moment; don't lecture.
- The app also shows groups, counselors, and other resources when relevant. You may offer one, but never quote, name, or list any, and never say you can't provide them.
- No therapy, diagnosis, or medical advice.
- You may gently use what you're told about their check-ins and setup answers (accountability partner/pastor by name, when or where they're usually tempted). Never recite it back as a list — weave it in naturally.
- If they sound hopeless, mention the 988 Lifeline is free by call or text, anytime.
- If a message has nothing to do with their life, faith, or recovery, don't answer it. Kindly say you're only here for those.`;

// async because small_group_finder/sermon_library/article_finder/counseling_directory all read
// live from Supabase now (see ResourceRepo) -- every other branch below still resolves
// synchronously, `await`ing a non-promise is a no-op.
async function executeAgentTool(name, input) {
  const theme = input && input.theme ? input.theme : null;
  switch (name) {
    case "scripture_search":
      return agentFindVerse(theme);
    case "devotional_finder":
      return ResourceRepo.getDevotional(theme);
    case "bible_plan_finder":
      return { plans: ResourceRepo.getBiblePlans() };
    case "article_finder":
      return { articles: await ResourceRepo.getArticles() };
    case "coping_toolkit":
      return { mechanisms: ResourceRepo.getCopingMechanisms(theme) };
    case "small_group_finder":
      return { groups: await ResourceRepo.getSmallGroups(input && input.query) };
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
      return { sermons: await ResourceRepo.getSermons() };
    case "counseling_directory":
      return { centers: await ResourceRepo.getCounselingCenters() };
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// Every verse Chat shows goes through the YouVersion Bible display (youversion.js, rendered by
// app.js renderToolResult). A detected theme keeps its hand-picked verse from seedData.js, just
// fetched from YouVersion; a plain "share a verse" gets YouVersion's Verse of the Day -- the same
// "Today's Verse" Home shows. No app key / offline / API error -> the local verse, as before.
async function agentFindVerse(theme) {
  const local = ResourceRepo.getScripture(theme);
  if (typeof YouVersion === "undefined" || !YouVersion.available()) return local;
  const display = theme && local ? await YouVersion.getVerse(local.title) : await YouVersion.getTodaysVerse();
  if (!display) return local;
  return {
    ...(local || {}),
    title: display.reference,
    // Local body only matches when it's the same verse; today's verse has no local text.
    body: theme && local ? local.body : null,
    todaysVerse: !theme,
    youversion: display,
  };
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
