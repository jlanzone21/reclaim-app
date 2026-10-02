// Constants and helpers shared by background.js, content.js, and the popup.
// Classic script (no modules) so the same file loads as a service-worker importScripts(), a
// content script, and a popup <script>.
(function (root) {
  // Origins the web app is served from. The bridge content script is injected ONLY on these
  // (manifest.json), and background.js re-checks the sender's origin against this list before
  // handing out any tracking data -- otherwise any website could ask for browsing history.
  const APP_ORIGINS = ["https://reclaim128.org", "http://localhost:4173"];

  // Three severity tiers, mirroring TrackingAccessibilityService.KEYWORDS_SEVERE/MODERATE/MILD
  // (Android) and weighed by RiskScorer the same way: SEVERE is a fixed bonus that guarantees a
  // notification, MODERATE and MILD are ordinary adaptive factors, smaller for MILD. SEVERE is kept
  // to site names and unambiguous search phrases -- single words with innocent uses (nude, erotic,
  // fetish, xxx, nsfw, even "porn" alone, which shows up in anti-porn articles and news) stay
  // MODERATE or MILD so one ambiguous word can't guarantee a nudge by itself.
  //
  // Matching differs from Android on purpose: Android substring-matches short on-screen snippets;
  // a whole web page is far larger, so substrings ("nude" inside "denuded") would fire constantly.
  // Web matches whole words/phrases only. That also lets the web list include words Android can't
  // (milf, orgy, erome, motherless -- all substrings of ordinary words/names). Hostnames are
  // checked against the same lists, so visiting pornhub.com counts without any page text.
  const SEVERE = {
    // Major site names -- specific enough on their own.
    pornhub: "adult_site", xvideos: "adult_site", xhamster: "adult_site", xnxx: "adult_site",
    redtube: "adult_site", youporn: "adult_site", brazzers: "adult_site", spankbang: "adult_site",
    chaturbate: "adult_site", onlyfans: "adult_site", stripchat: "adult_site", livejasmin: "adult_site",
    bongacams: "adult_site", myfreecams: "adult_site", camsoda: "adult_site", fansly: "adult_site",
    eporner: "adult_site", tube8: "adult_site", nhentai: "adult_site", fapello: "adult_site",
    thothub: "adult_site", erome: "adult_site",
    // Explicit, unambiguous search/intent phrases.
    "watch porn": "explicit_content", "free porn": "explicit_content", "porn videos": "explicit_content",
    "hardcore porn": "explicit_content", "porn site": "explicit_content",
    // Solicitation -- its own real-world risk beyond pornography specifically.
    "hire an escort": "adult_site", "book an escort": "adult_site", "escort service": "adult_site",
  };

  const MODERATE = {
    porn: "explicit_content", pornography: "explicit_content", porno: "explicit_content",
    pornographic: "explicit_content", pornstar: "explicit_content", pornstars: "explicit_content",
    "porn star": "explicit_content", xxx: "explicit_content", nsfw: "explicit_content",
    nudes: "explicit_content", "nude video": "explicit_content", "nude photos": "explicit_content",
    "naked pics": "explicit_content", "naked photos": "explicit_content", "send nudes": "explicit_content",
    "leaked nudes": "explicit_content", hentai: "explicit_content", rule34: "explicit_content",
    "rule 34": "explicit_content", erotic: "explicit_content", erotica: "explicit_content",
    fetish: "explicit_content", sexting: "explicit_content", "adult video": "explicit_content",
    "adult film": "explicit_content", "sex tape": "explicit_content", "sex video": "explicit_content",
    "sex videos": "explicit_content", "sex cam": "explicit_content", "sex chat": "explicit_content",
    blowjob: "explicit_content", handjob: "explicit_content", cumshot: "explicit_content",
    creampie: "explicit_content", gangbang: "explicit_content", threesome: "explicit_content",
    orgy: "explicit_content", milf: "explicit_content", camgirl: "explicit_content",
    camgirls: "explicit_content", "cam girl": "adult_site", "cam girls": "adult_site",
    "live cam": "adult_site", "strip club": "adult_site",
    escort: "adult_site", escorts: "adult_site", "call girl": "adult_site", "call girls": "adult_site",
    brothel: "adult_site", motherless: "adult_site", "ashley madison": "adult_site",
    ashleymadison: "adult_site", adultfriendfinder: "adult_site",
  };

  const MILD = {
    nude: "explicit_content", "sexy pics": "explicit_content", "hot pics": "explicit_content",
    "thirst trap": "explicit_content", risque: "explicit_content", "18+": "explicit_content",
    "lingerie pics": "explicit_content", "swimsuit pics": "explicit_content",
    hardcore: "explicit_content", softcore: "explicit_content", masturbate: "explicit_content",
    masturbation: "explicit_content", naked: "explicit_content", topless: "explicit_content",
    lewd: "explicit_content", "hookup app": "adult_site", "cam site": "adult_site",
  };

  // keyword -> category, and keyword -> severity, flattened from the tiers (a keyword is in
  // exactly one tier; the test suite checks that).
  const KEYWORDS = {};
  const KEYWORD_SEVERITY = {};
  for (const [tier, map] of [["severe", SEVERE], ["moderate", MODERATE], ["mild", MILD]]) {
    for (const [kw, category] of Object.entries(map)) {
      KEYWORDS[kw] = category;
      KEYWORD_SEVERITY[kw] = tier;
    }
  }

  // Page text is never read on these (webmail, messaging, banking, health). The user chose
  // "scan everywhere except a sensitive list, plus per-site opt-outs" over a pure allowlist;
  // see PURPOSE.md. Domain and time are still recorded locally so the time-of-day signal exists.
  const SENSITIVE_DOMAINS = [
    "mail.google.com", "outlook.com", "outlook.live.com", "mail.yahoo.com", "protonmail.com", "proton.me",
    "web.whatsapp.com", "messenger.com", "discord.com", "slack.com", "teams.microsoft.com", "web.telegram.org",
    "chase.com", "bankofamerica.com", "wellsfargo.com", "citi.com", "citibank.com",
    "paypal.com", "venmo.com", "capitalone.com", "usbank.com", "ally.com",
    "mychart.com", "healthcare.gov", "kaiserpermanente.org", "webmd.com",
    "cvs.com", "walgreens.com", "goodrx.com",
  ];

  // Web equivalent of Android's trigger-app allowlist: user-editable, seeded with these.
  const DEFAULT_TRIGGER_DOMAINS = [
    "youtube.com", "instagram.com", "tiktok.com", "reddit.com", "x.com", "twitter.com",
    "snapchat.com", "facebook.com",
  ];

  // Same as RiskScorer.SOCIAL_MEDIA_PACKAGES, as domains (YouTube is a trigger site but, as on
  // Android, not counted as "social media").
  const SOCIAL_MEDIA_DOMAINS = [
    "instagram.com", "tiktok.com", "reddit.com", "x.com", "twitter.com", "snapchat.com", "facebook.com",
  ];

  function domainMatches(host, list) {
    if (!host) return false;
    return list.some((d) => host === d || host.endsWith("." + d));
  }

  function hostnameOf(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      return u.hostname.replace(/^www\./, "");
    } catch {
      return null;
    }
  }

  function isAppUrl(url) {
    try {
      return APP_ORIGINS.includes(new URL(url).origin);
    } catch {
      return false;
    }
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  const KEYWORD_REGEXES = Object.keys(KEYWORDS).map((kw) => ({
    keyword: kw,
    category: KEYWORDS[kw],
    re: new RegExp("(^|[^a-z0-9])" + escapeRegex(kw) + "([^a-z0-9]|$)"),
  }));

  // Returns [{keyword, category}] found in `text`. Only these tiny records ever leave the page --
  // never the text itself.
  function findKeywords(text) {
    const lower = String(text || "").toLowerCase();
    return KEYWORD_REGEXES.filter((k) => k.re.test(lower)).map((k) => ({ keyword: k.keyword, category: k.category }));
  }

  root.ReclaimShared = {
    APP_ORIGINS,
    KEYWORDS,
    KEYWORD_SEVERITY,
    SENSITIVE_DOMAINS,
    DEFAULT_TRIGGER_DOMAINS,
    SOCIAL_MEDIA_DOMAINS,
    domainMatches,
    hostnameOf,
    isAppUrl,
    findKeywords,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = root.ReclaimShared;
})(typeof globalThis !== "undefined" ? globalThis : this);
