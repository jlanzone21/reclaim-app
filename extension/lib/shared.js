// Constants and helpers shared by background.js, content.js, and the popup.
// Classic script (no modules) so the same file loads as a service-worker importScripts(), a
// content script, and a popup <script>.
(function (root) {
  // Origins the web app is served from. The bridge content script is injected ONLY on these
  // (manifest.json), and background.js re-checks the sender's origin against this list before
  // handing out any tracking data -- otherwise any website could ask for browsing history.
  const APP_ORIGINS = ["https://reclaim128.org", "http://localhost:4173"];

  // Same starter list as TrackingAccessibilityService.KEYWORDS (Android). Matching differs on
  // purpose: Android substring-matches short on-screen snippets; a whole web page is far larger,
  // so substrings ("nude" inside "denuded") would fire constantly. Web matches whole words only.
  // Whole-word matching still can't tell "escort" the service from "Ford Escort" -- an accepted
  // over-trigger, in line with the project's lean toward over-triggering.
  const KEYWORDS = {
    porn: "explicit_content",
    pornography: "explicit_content",
    xxx: "explicit_content",
    nsfw: "explicit_content",
    nude: "explicit_content",
    nudes: "explicit_content",
    hentai: "explicit_content",
    erotic: "explicit_content",
    erotica: "explicit_content",
    fetish: "explicit_content",
    "adult video": "explicit_content",
    "adult film": "explicit_content",
    sexting: "explicit_content",
    onlyfans: "adult_site",
    pornhub: "adult_site",
    xvideos: "adult_site",
    xhamster: "adult_site",
    chaturbate: "adult_site",
    escort: "adult_site",
    "strip club": "adult_site",

    // Added for the web version (Android's list is still the original 20). Whole-word matching and
    // hostname matching apply, so a bare site name like "xnxx" also catches xnxx.com.
    // Explicit content: terms and slang
    porno: "explicit_content",
    pornographic: "explicit_content",
    pornstar: "explicit_content",
    "porn star": "explicit_content",
    pornstars: "explicit_content",
    "sex tape": "explicit_content",
    "sex video": "explicit_content",
    "sex videos": "explicit_content",
    "sex cam": "explicit_content",
    "sex chat": "explicit_content",
    hardcore: "explicit_content",
    softcore: "explicit_content",
    milf: "explicit_content",
    blowjob: "explicit_content",
    handjob: "explicit_content",
    cumshot: "explicit_content",
    creampie: "explicit_content",
    gangbang: "explicit_content",
    threesome: "explicit_content",
    orgy: "explicit_content",
    masturbate: "explicit_content",
    masturbation: "explicit_content",
    camgirl: "explicit_content",
    camgirls: "explicit_content",
    "cam girl": "explicit_content",
    "cam girls": "explicit_content",
    "leaked nudes": "explicit_content",
    naked: "explicit_content",
    topless: "explicit_content",
    lewd: "explicit_content",
    "rule34": "explicit_content",
    "rule 34": "explicit_content",
    // Adult sites and services
    redtube: "adult_site",
    youporn: "adult_site",
    xnxx: "adult_site",
    spankbang: "adult_site",
    brazzers: "adult_site",
    stripchat: "adult_site",
    bongacams: "adult_site",
    livejasmin: "adult_site",
    myfreecams: "adult_site",
    camsoda: "adult_site",
    fansly: "adult_site",
    eporner: "adult_site",
    tube8: "adult_site",
    motherless: "adult_site",
    nhentai: "adult_site",
    erome: "adult_site",
    fapello: "adult_site",
    thothub: "adult_site",
    "ashley madison": "adult_site",
    ashleymadison: "adult_site",
    adultfriendfinder: "adult_site",
    escorts: "adult_site",
    "call girl": "adult_site",
    "call girls": "adult_site",
    brothel: "adult_site",
  };

  // Keywords explicit enough that a match alone is treated as high risk, regardless of the user's
  // notification intensity (RiskScorer's "explicit keyword" floor). Deliberately narrower than
  // KEYWORDS: words that are common in non-pornographic contexts (nsfw, nude, erotic, fetish,
  // escort, strip club, sexting) still only add the ordinary keyword points. This over-triggers
  // on anti-porn articles and news about these sites, by design -- see CLAUDE.md on gaps.
  const STRONG_KEYWORDS = [
    "porn", "pornography", "xxx", "hentai", "pornhub", "xvideos", "xhamster", "chaturbate",
    "onlyfans", "adult video", "adult film",
    "porno", "pornographic", "pornstar", "pornstars", "porn star", "blowjob", "handjob", "cumshot",
    "creampie", "gangbang", "milf", "redtube", "youporn", "xnxx", "spankbang", "brazzers",
    "stripchat", "bongacams", "livejasmin", "myfreecams", "camsoda", "fansly", "eporner", "tube8",
    "nhentai",
  ];

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
    STRONG_KEYWORDS,
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
