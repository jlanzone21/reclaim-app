// Fixed, reviewed answers for questions the on-device model must not answer itself.
//
// A 1000-prompt test of the real model (see llm-prompt-tests/) showed it making up facts about the app ("there is a paid
// version", "the app does not track your personal data", "yes, a human is reading this") and sometimes answering requests to
// find or excuse porn ("you can watch soft porn if it helps you"). A prompt can't hold those down reliably, so they are
// answered here, in code, with text a person has read. Runs right after the crisis check and before card routing or any
// model call, for both ReclaimAgent and ResourcesAgent (Basic mode).
//
// Keep it small and precise: every pattern should be a clear question about the app or a clear request to find/excuse
// porn. A wrong match hijacks a real message, so when a message is ambiguous it should fall through to the normal path.
// Facts here come from the app's own copy (welcome notice, Privacy tab, Insights tab) and README/PURPOSE; where the
// project doesn't say (price, iPhone, who to contact) the answer says "I don't have that information" instead of guessing.
const FixedAnswers = (function () {
  // Words that mean the message is about recovering from / learning about porn, not finding it.
  const RECOVERY_CONTEXT =
    /\b(help|stop|quit|quitting|avoid|block|blocker|filter|resist|overcome|recover\w*|without|freedom|free from|fight|struggl\w*|addict\w*|article|articles|book|books|podcast|sermon|devotional|read|reading|marriage|wife|husband|spouse|brain|science|harm\w*|effects?|why|counsel\w*|therap\w*|group|church|pastor|verse|bible|scripture|accountab\w*|sin|sinful|wrong|clean|sober|abstain\w*)\b/;

  const PORN_OBJECT = "(?:porn(?:ography)?|nudes?|naked (?:pics?|pictures?|photos?|women|men|girls?|guys?)|xxx|nsfw|adult (?:videos?|content|sites?|websites?|films?|movies?)|sex videos?)";

  const REFUSE_FIND =
    "I can't help with that. It works against what you're trying to do here. If you're feeling the pull right now, I can help you find a coping tool, or a person to reach out to, like an accountability partner, a pastor, or a counselor.";
  const REFUSE_HIDE =
    "I can't help with hiding activity or getting around a filter. Your accountability partner, a pastor, or a counselor is the right person to talk to about this.";
  const TAKE_TO_PERSON =
    "That's a question for a real person, not for me. A pastor, counselor, or accountability partner can talk it through with you.";

  const PRIVACY =
    "Your conversations with me and your check-ins stay on your device. The AI runs on your device, and check-ins are stored on your device and aren't sent anywhere. Nobody reads your chats. The app does go online for the one-time AI download, Bible verses from YouVersion, and the directory of groups, sermons, articles, and counselors. Those lookups don't include your messages, only things like the kind of resource and a US state if you mention one.";
  const TRACKING =
    "On Android, if you choose, Reclaim can notice patterns on your own phone, like which apps you open, roughly where you are, and keywords on screen in apps you add to its list. It's off until you grant each permission in the Privacy tab, it all stays on your device, and nothing is sent anywhere. You can change or turn off any of it at any time, and Reclaim works without it. The web and desktop versions don't do any of this.";
  const DATA =
    "In the Insights tab you can export your check-ins as a file (Export data) or clear them (Clear all check-in data). Your data is only on this device, so there is no other copy unless you export one. Removing the app also erases it.";
  const AI_DOWNLOAD =
    "The AI runs on your device so your conversations never leave it. That's why it needs a one-time download of about 1 GB (Wi-Fi recommended). After that the chat works without internet, though looking up groups, sermons, articles, counselors, and Bible verses still needs a connection. How fast it replies depends on your device.";
  const BIBLE_VERSION =
    "Verses are shown through YouVersion, in the NIV when it's available and the BSB otherwise, along with the version's copyright notice. That's why you see \"Provided by YouVersion\" under a verse.";
  const SAMPLE_TAG =
    "A Sample tag marks placeholder content that hasn't been replaced with a real, checked resource yet. Don't rely on it for a phone number or contact.";
  const PLATFORMS =
    "I only know of the web version, a Windows desktop app, and an Android app. I don't have information about other platforms.";
  const PRICE = "I don't have any information about pricing.";
  const ABOUT =
    "Reclaim helps you find scripture, community, accountability, and counseling for struggles with pornography. It's a starting point, not a solution on its own, and never a substitute for a real pastor, counselor, or accountability partner. I don't have details about who built it or how to contact them.";
  const APP_HELP =
    "Here is where things are. Check-In is where you log a good or hard moment. Insights shows a picture of your check-ins and lets you export or clear them. In Privacy, Edit your preferences is where you add your accountability partner and pastor, your tempting times, and how often you want to hear from Reclaim. On Android, the Privacy tab also has the permissions and background sampling. Notifications can also be turned off in your phone's settings.";
  const CAPABILITIES =
    "I can help you find a Bible verse, a devotional, a Bible reading plan, an article, a sermon, a coping tool, a small group, your accountability partner, or a counselor. I don't answer other questions or give advice.";

  // Order matters: first match wins.
  const INTENTS = [
    {
      id: "find-porn",
      reply: REFUSE_FIND,
      test: (t) =>
        !RECOVERY_CONTEXT.test(t) &&
        (new RegExp(`\\bwhere (?:can|could|do|should) i (?:watch|find|get|see|view|download|stream|look at|access)\\b[^.?!]*\\b${PORN_OBJECT}\\b`).test(t) ||
          new RegExp(`\\bhow (?:can|do|could|would|to)\\b[^.?!]*\\b(?:get|find|watch|see|download|access)\\b[^.?!]*\\b${PORN_OBJECT}\\b`).test(t) ||
          new RegExp(`\\b(?:best|top|good|free|safe) ${PORN_OBJECT}\\b[^.?!]*\\b(?:sites?|websites?|videos?|links?)\\b|\\b(?:best|top|good|free|safe) (?:sites?|websites?) for ${PORN_OBJECT}\\b`).test(t) ||
          new RegExp(`\\b(?:link|links|url|site|sites|website|websites)s? (?:to|for) ${PORN_OBJECT}\\b|\\b${PORN_OBJECT} (?:sites?|websites?|links?|urls?)\\b`).test(t) ||
          new RegExp(`\\b(?:recommend|suggest|show me|send me|give me) [^.?!]*\\b${PORN_OBJECT}\\b`).test(t)),
    },
    {
      id: "hide-or-bypass",
      reply: REFUSE_HIDE,
      test: (t) =>
        /\b(?:bypass|get around|circumvent|disable|turn off|uninstall|unblock|break)\b[^.?!]*\b(?:blocker|filter|porn block\w*|accountability (?:software|app)|covenant eyes|parental controls?)\b/.test(t) ||
        /\b(?:hide|conceal|cover up|keep (?:it )?secret)\b[^.?!]*\b(?:from my (?:wife|husband|partner|parents?|pastor|girlfriend|boyfriend|accountability)|browsing history|search history)\b/.test(t) ||
        /\bwithout (?:anyone|anybody|them|him|her|my (?:wife|husband|partner)) knowing\b/.test(t) ||
        /\b(?:private|incognito) (?:browser|browsing|mode|window)\b/.test(t),
    },
    {
      id: "porn-permission",
      reply: TAKE_TO_PERSON,
      test: (t) =>
        /\b(?:is it|would it be|am i|is that)\b[^.?!]*\b(?:ok|okay|fine|alright|acceptable|allowed|wrong|a sin|bad|harmful)\b[^.?!]*\b(?:soft ?(?:core)?|mild|just (?:a little|looking|look\w*)|a little|look\w* (?:a little|if i)|if i don'?t touch|without touching)\b/.test(t) ||
        /\bsoft ?(?:core )?porn\b/.test(t) ||
        /\bhow (?:old|young)\b[^.?!]*\b(?:watch|see|view|look at)\b[^.?!]*\bporn/.test(t),
    },
    {
      id: "tracking",
      reply: TRACKING,
      test: (t) =>
        /\b(?:does|do|is|are|can|will)\b (?:this |the |that )?(?:app|reclaim|you|it)\b[^.?!]*\b(?:track|spy|monitor|listen)\b/.test(t) ||
        /\b(?:spyware|stalkerware)\b/.test(t) ||
        /\btracking\b[^.?!]*\b(?:app|mean|work|do)\b/.test(t) ||
        /\bcan (?:you|the app|reclaim|it) (?:read|see) my (?:screen|phone|messages?|texts?|location|apps?)\b/.test(t) ||
        /\bwhat (?:can|does) (?:the |this )?(?:app|reclaim)\b[^.?!]*\b(?:see|read|access|know|collect)\b/.test(t) ||
        /\b(?:what|which|why)\b[^.?!]*\b(?:permissions?|accessibility|usage access|notification access|location access)\b/.test(t) ||
        /\b(?:background sampling|allowlist|risk alerts?|nudges?)\b/.test(t),
    },
    {
      id: "privacy",
      reply: PRIVACY,
      test: (t) =>
        /\b(?:app|chat|data|conversations?|check-?ins?|information|info|messages?)\b[^.?!]*\b(?:private|privacy|confidential|secure|safe)\b/.test(t) ||
        /\b(?:private|privacy|confidential|secure|safe)\b[^.?!]*\b(?:app|chat|data|conversations?|check-?ins?|information|info)\b/.test(t) ||
        /\b(?:is|are) (?:a |any )?(?:human|person|someone|somebody|anyone|anybody) (?:reading|watching|listening|seeing)\b/.test(t) ||
        /\bcan (?:anyone|anybody|someone|somebody|my (?:wife|husband|partner|pastor|parents?|boss|friend)|other people)\b[^.?!]*\b(?:see|read|access|view)\b[^.?!]*\b(?:chat|conversation|messages?|check-?ins?|data|usage|activity|this)\b/.test(t) ||
        /\bdoes (?:this |the )?(?:app|reclaim|ai|chat)?\b[^.?!]*\b(?:send|share|upload|sell|store|save|collect)\b[^.?!]*\b(?:info|information|data|conversations?|messages?|anywhere|anyone)\b/.test(t) ||
        /\b(?:are you|is it|is this) (?:recording|logging|saving|storing)\b/.test(t) ||
        /\bwhere (?:is|are|does|do) my (?:data|info|information|check-?ins?|conversations?|messages?) (?:stored|saved|kept|go)\b/.test(t),
    },
    {
      id: "data",
      reply: DATA,
      test: (t) =>
        !/\b(?:browsing|search|browser) history\b/.test(t) &&
        /\b(?:delete|erase|remove|clear|wipe|reset|export|back ?up)\b[^.?!]*\b(?:my )?(?:data|check-?ins?|account|app|everything|conversations?)\b/.test(t),
    },
    {
      id: "ai-download",
      reply: AI_DOWNLOAD,
      test: (t) =>
        /\bwhy\b[^.?!]*\b(?:download|downloading)\b[^.?!]*\b(?:ai|model)\b/.test(t) ||
        /\b(?:download|downloading)\b[^.?!]*\b(?:ai|model)\b|\b(?:ai|model)\b[^.?!]*\b(?:download|gb|offline|storage|space)\b/.test(t) ||
        /\bhow (?:big|large)\b[^.?!]*\bdownload\b/.test(t) ||
        /\b(?:works?|work) offline\b|\bwithout (?:the )?(?:internet|wi-?fi)\b/.test(t) ||
        /\bwhy is (?:the |your )?(?:ai|chat)\b[^.?!]*\bslow\b/.test(t) ||
        /\bdoes the ai use my (?:phone'?s )?(?:data|internet)\b/.test(t),
    },
    {
      id: "bible-version",
      reply: BIBLE_VERSION,
      test: (t) =>
        /\bwhich bible (?:version|translation) (?:is|does|do|are)\b[^.?!]*\b(?:used|use|using|shown|app|you|this|reclaim)\b|\bwhat bible (?:version|translation) (?:is|does|do|are)\b/.test(t) ||
        /\bwhy does (?:a|the|every) verse say\b[^.?!]*\byouversion\b|\bprovided by youversion\b/.test(t),
    },
    {
      id: "sample-tag",
      reply: SAMPLE_TAG,
      test: (t) => /\bsample tags?\b|\bwhat (?:does|do) (?:the )?sample\b|\bwhy (?:does|do|is) [^.?!]*\bsample\b/.test(t),
    },
    {
      id: "platforms",
      reply: PLATFORMS,
      test: (t) =>
        /\b(?:is there|do you have|available (?:on|for)|does it (?:work|run) on|can i (?:use|get) (?:it|this|the app) on)\b[^.?!]*\b(?:iphone|ios|apple|android|web|browser|desktop|windows|mac|computer|laptop|tablet)\b/.test(t) ||
        /\b(?:iphone|ios|android|web|desktop|windows|mac) (?:version|app)\b/.test(t),
    },
    {
      id: "price",
      reply: PRICE,
      test: (t) =>
        /\b(?:paid version|paid app|premium|subscription|pricing|in-app purchases?)\b/.test(t) ||
        /\bhow much does (?:it|this|the app|reclaim)\b[^.?!]*\bcost\b|\bdoes (?:it|this|the app|reclaim) cost\b|\bis (?:this|it|the app|reclaim) (?:app )?free\b|\bdo i have to pay\b/.test(t),
    },
    {
      id: "about",
      reply: ABOUT,
      test: (t) =>
        /\bwhat is (?:reclaim|this app|the app)\b|\bwhat does (?:the )?128 mean\b|\bwho (?:made|built|created|runs|owns|developed) (?:this|the) (?:app|reclaim)\b|\bwho is behind (?:this|reclaim|the app)\b|\bhow do i contact (?:the )?(?:developers?|team|creators)\b|\b(?:give|send) feedback\b|\breport a bug\b/.test(t),
    },
    {
      id: "app-help",
      reply: APP_HELP,
      test: (t) =>
        /\bhow (?:does|do) (?:this|the) app work\b|\bhow does reclaim work\b|\bhow (?:do|does) (?:the )?(?:nightly )?check-?ins? work\b|\bwhat(?: is|'s| does) the (?:nightly )?(?:insights|privacy|check-?in|home|chat) (?:tab|page|screen|section)\b|\bwhat does the nightly check-?in\b/.test(t) ||
        /\bhow (?:do|can) i (?:log|record|add|enter|change|edit|update|set|turn (?:on|off))\b[^.?!]*\b(?:slip|check-?in|accountability partner|partner|pastor|settings?|preferences?|home|location|notifications?|reminders?)\b/.test(t) ||
        /\bwhere (?:do|can) i (?:enter|add|put|change)\b[^.?!]*\b(?:pastor|partner|number|settings?|preferences?)\b/.test(t) ||
        /\bwhy did i get a notification\b|\bwhy (?:am i|are you) (?:getting|sending)\b[^.?!]*\bnotifications?\b/.test(t),
    },
    {
      id: "capabilities",
      reply: CAPABILITIES,
      test: (t) =>
        /\bwhat (?:can|do) you (?:do|offer|have|provide)\b|\bwhat (?:resources|kinds of resources|tools) (?:can|do) you\b|\bwhat can i ask you\b|\bwhat are you able to\b|\bwhat can you help (?:me )?with\b|\bhow can you help( me)?\s*\??$/.test(t),
    },
  ];

  function normalize(text) {
    return String(text || "").toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
  }

  // Returns { id, reply } for a message that gets a fixed answer, or null to continue the normal path.
  function match(text) {
    const t = normalize(text);
    if (!t) return null;
    for (const intent of INTENTS) {
      if (intent.test(t)) return { id: intent.id, reply: intent.reply };
    }
    return null;
  }

  return { match, INTENTS };
})();
