// Re-checks the embedding model's calibrated thresholds (web/js/localEmbedder.js) against held-out
// messages -- none of these appear in its example lists. Needs the real model, so it runs in the
// app itself: open Reclaim with the AI turned on, wait until LocalEmbedder.getState() is "ready",
// then paste this whole file into the devtools console (desktop browser, or chrome://inspect for
// the Android WebView). Re-run it after editing the example lists, EVERYDAY_NONE, GOOD_NEWS or the
// margins -- and add fresh lines here rather than reusing ones you tuned on.
//
// Baseline (2026-10-07, Intel laptop GPU): see the header of web/js/localEmbedder.js.
(async () => {
  const feelings = [
    // set 1 (2026-10-06)
    ["I can't stop beating myself up over it", "shame"], ["the craving won't go away", "temptation"],
    ["I'm sitting here by myself again", "loneliness"], ["I'm freaking out about tomorrow", "anxiety"],
    ["I have three exams and a job and I'm fried", "stress"], ["honestly I don't think I'll ever change", "hope"],
    ["I caved last night after 12 days", "relapse"], ["would God even take me back", "grace"],
    ["I feel like a hypocrite at church", "identity"], ["I'm sick of this having power over me", "freedom"],
    ["I don't have it in me to keep fighting", "perseverance"], ["I wish I had a group of guys to be real with", "community"],
    ["every time I'm bored on my phone it starts", "triggers"], ["I want my faith to be real again", "growth"],
    ["today has been a grind", "struggle"], ["I feel like trash after what I watched", "shame"],
    ["I'm one click away from messing up", "temptation"], ["my roommates are gone all weekend and it's quiet", "loneliness"],
    // sets 2-3 (2026-10-07)
    ["I can't stop thinking about it tonight", "temptation"], ["I feel so far from God", "grace"], ["I messed up again", "relapse"],
    ["I hate what I've become", "shame"], ["nobody would understand", "loneliness"], ["I'm drowning", "stress"],
    ["I don't know how to stop", "hope"], ["I'm scared I'll never change", "hope"], ["the pull is really strong right now", "temptation"],
    ["I feel like a fake", "identity"], ["I went back to it again last night", "relapse"], ["I'm ashamed of my search history", "shame"],
    ["I feel so empty inside", "struggle"], ["I want to look so bad right now", "temptation"], ["I can't keep doing this", "perseverance"],
    ["I'm afraid my wife will find out", "anxiety"], ["I'm so tired of fighting", "perseverance"], ["I feel invisible", "loneliness"],
    ["God feels so distant", "grace"], ["my mind won't stop going there", "temptation"],
  ];
  const smallTalk = [
    "hey there", "what's for dinner", "can you play music", "the weather is nice", "haha", "where are my settings",
    "I'm on the bus", "thanks a lot", "good afternoon", "what does this button do", "I watched a movie with friends",
    "see you tomorrow", "how many check-ins do I have", "I'm going to bed soon", "my dog is cute", "what's 2+2", "can you talk", "I like pizza",
    "how's your day", "what's the time in London", "do you know any good recipes", "I just got back from the gym", "my phone battery is low",
    "can I change the app color", "who won the game", "what does 128 mean", "good evening", "I'm watching a show",
    "I just ate a burrito", "traffic was terrible", "my roommate is loud", "the sunset is pretty", "I bought new shoes", "my laptop crashed",
    "I'm at the beach", "basketball tonight", "what should I name my cat", "I'm folding laundry", "it's my birthday", "my coffee is cold",
    "I'm waiting for the bus", "what's the best pizza topping", "my plane lands at noon", "I'm proud of my streak",
    "just got home from basketball", "I'm feeling good about this week", "I hit 60 days today", "came back from a hike", "my phone died earlier",
    "I'm back from church", "finally finished my essay", "the kids are asleep", "I'm proud of my progress", "got back from the store",
    "my battery is at 5 percent", "we won our game tonight", "I'm so happy today", "I ran 3 miles", "I'm on day 14",
    "30 days and counting", "longest streak ever for me", "I made it through the weekend clean", "I'm on day 45", "I haven't looked in two weeks",
  ];
  const asks = [
    ["is there anyone I could talk to about this professionally", "counseling_directory"], ["are there people who meet up to work through this together", "small_group_finder"],
    ["something I could listen to on my commute about this", "sermon_library"], ["I'd like to understand what this is doing to my brain", "article_finder"],
    ["how do I build a habit of reading God's word each day", "bible_plan_finder"], ["a little encouragement to think about this morning", "devotional_finder"],
    ["is there anything in God's word about lust", "scripture_search"], ["help me not do it right now", "coping_toolkit"],
    ["I need someone in my life who will ask me the hard questions", "accountability_match"], ["who could I see about this, like a professional", "counseling_directory"],
    ["I want to find some guys at a church who deal with this", "small_group_finder"], ["what should I do instead of looking", "coping_toolkit"],
  ];

  if (!LocalEmbedder.isReady()) return console.warn("LocalEmbedder isn't ready yet:", LocalEmbedder.getState());
  const run = async (texts) => {
    const out = [];
    for (const t of texts) out.push(await LocalEmbedder.analyze(t));
    return out;
  };
  const F = await run(feelings.map((f) => f[0]));
  const S = await run(smallTalk);
  const A = await run(asks.map((a) => a[0]));
  const through = smallTalk.filter((t, i) => S[i].theme || S[i].ask);
  console.table(feelings.map(([text, want], i) => ({ text, want, got: F[i].theme, margin: F[i].themeMargin.toFixed(3) })));
  console.table(asks.map(([text, want], i) => ({ text, want, got: A[i].ask, margin: A[i].askMargin.toFixed(3) })));
  const summary = [
    `themes: ${F.filter((r) => r.theme).length}/${feelings.length} real feelings caught (${F.filter((r, i) => r.theme === feelings[i][1]).length} exact theme)`,
    `small talk: ${through.length}/${smallTalk.length} let through (${through.join("; ") || "none"})`,
    `asks: ${A.filter((r, i) => r.ask === asks[i][1]).length}/${asks.length} caught, ${A.filter((r, i) => r.ask && r.ask !== asks[i][1]).length} wrong kind`,
  ];
  summary.forEach((line) => console.log(line));
  return summary;
})();
