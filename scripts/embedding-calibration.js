// Re-checks the embedding model's calibrated thresholds (web/js/localEmbedder.js) against held-out
// messages -- none of these appear in its example lists. Needs the real model, so it runs in the
// app itself: open Reclaim with the AI turned on, wait until LocalEmbedder.getState() is "ready",
// then paste this whole file into the devtools console (desktop browser, or chrome://inspect for
// the Android WebView). Re-run it after editing THEME_EXAMPLES / ASK_EXAMPLES or the margins.
//
// Baseline (2026-10-06, Intel laptop GPU, with the chat model loaded too): themes 15/18 caught
// (11 exact), 0/18 small talk let through; asks 6/12 caught, 1 wrong kind, 0/15 non-asks let
// through.
(async () => {
  const feelings = [
    ["I can't stop beating myself up over it", "shame"], ["the craving won't go away", "temptation"],
    ["I'm sitting here by myself again", "loneliness"], ["I'm freaking out about tomorrow", "anxiety"],
    ["I have three exams and a job and I'm fried", "stress"], ["honestly I don't think I'll ever change", "hope"],
    ["I caved last night after 12 days", "relapse"], ["would God even take me back", "grace"],
    ["I feel like a hypocrite at church", "identity"], ["I'm sick of this having power over me", "freedom"],
    ["I don't have it in me to keep fighting", "perseverance"], ["I wish I had a group of guys to be real with", "community"],
    ["every time I'm bored on my phone it starts", "triggers"], ["I want my faith to be real again", "growth"],
    ["today has been a grind", "struggle"], ["I feel like trash after what I watched", "shame"],
    ["I'm one click away from messing up", "temptation"], ["my roommates are gone all weekend and it's quiet", "loneliness"],
  ];
  const smallTalk = ["hey there", "what's for dinner", "can you play music", "the weather is nice", "haha", "where are my settings",
    "I'm on the bus", "thanks a lot", "good afternoon", "what does this button do", "I watched a movie with friends",
    "see you tomorrow", "how many check-ins do I have", "I'm going to bed soon", "my dog is cute", "what's 2+2", "can you talk", "I like pizza"];
  const asks = [
    ["is there anyone I could talk to about this professionally", "counseling_directory"], ["are there people who meet up to work through this together", "small_group_finder"],
    ["something I could listen to on my commute about this", "sermon_library"], ["I'd like to understand what this is doing to my brain", "article_finder"],
    ["how do I build a habit of reading God's word each day", "bible_plan_finder"], ["a little encouragement to think about this morning", "devotional_finder"],
    ["is there anything in God's word about lust", "scripture_search"], ["help me not do it right now", "coping_toolkit"],
    ["I need someone in my life who will ask me the hard questions", "accountability_match"], ["who could I see about this, like a professional", "counseling_directory"],
    ["I want to find some guys at a church who deal with this", "small_group_finder"], ["what should I do instead of looking", "coping_toolkit"],
  ];
  const nonAsks = ["I feel so alone tonight", "I slipped up yesterday", "work is crushing me", "hey", "thanks so much",
    "how do I change my notification time", "I'm proud of my streak", "today was okay", "I'm watching TV", "I hate this",
    "I feel like garbage", "my wife is upset with me", "I'm bored", "can't sleep", "it's been a long week"];

  if (!LocalEmbedder.isReady()) return console.warn("LocalEmbedder isn't ready yet:", LocalEmbedder.getState());
  const run = async (texts) => Promise.all(texts.map((t) => LocalEmbedder.analyze(t)));
  const F = await run(feelings.map((f) => f[0]));
  const S = await run(smallTalk);
  const A = await run(asks.map((a) => a[0]));
  const N = await run(nonAsks);
  console.table(feelings.map(([text, want], i) => ({ text, want, got: F[i].theme, margin: F[i].themeMargin.toFixed(3) })));
  console.table(asks.map(([text, want], i) => ({ text, want, got: A[i].ask, margin: A[i].askMargin.toFixed(3) })));
  console.log(
    `themes: ${F.filter((r) => r.theme).length}/${feelings.length} caught (${F.filter((r, i) => r.theme === feelings[i][1]).length} exact), ` +
      `${S.filter((r) => r.theme).length}/${smallTalk.length} small talk let through (${smallTalk.filter((t, i) => S[i].theme).join(", ") || "none"})`
  );
  console.log(
    `asks: ${A.filter((r, i) => r.ask === asks[i][1]).length}/${asks.length} caught, ${A.filter((r, i) => r.ask && r.ask !== asks[i][1]).length} wrong kind, ` +
      `${N.filter((r) => r.ask).length}/${nonAsks.length} non-asks let through (${nonAsks.filter((t, i) => N[i].ask).join(", ") || "none"})`
  );
})();
