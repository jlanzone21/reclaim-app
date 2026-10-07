# CLAUDE.md — Reclaim (reclaim-app)

Context for Claude Code sessions in this repo. Read this first, then
**README.md** (how the code works) and **PURPOSE.md** (why, the privacy
commitment, the roadmap checklist, and every major decision so far). This file
is the short version plus the practical things those two don't say. If
something here conflicts with the code, the code wins — fix this file.

---

## 1. What this is

**Reclaim 128** is an app that helps Christians fight pornography addiction
through prevention and intervention: connecting people to scripture, real
local small groups, accountability partners, pastors, sermons, and counseling;
letting them self-report check-ins; and (on Android) noticing risky patterns
on-device so a nudge can arrive *before* a slip, not after.

Non-negotiables (see PURPOSE.md for the full reasoning):

- **Never a substitute for real people.** Every feature points toward a
  pastor, counselor, accountability partner, or group. The safety banner,
  first-run disclaimer, and always-visible crisis resources (988 Lifeline,
  SAMHSA — hardcoded `CRISIS_LINES` in `web/js/constants.js`, work with zero
  network/database) must not be removed.
- **Nothing sensitive leaves the device.** Chat AI runs on-device; check-ins
  are local; the Android tracking system never touches a network. The
  tracking can read screen content — the same capability stalkerware uses —
  and is only legitimate because it's the user's own device, they explicitly
  consented knowing what's read, and nothing reaches a third party. Any change
  must be checked against all three.
- **Crisis detection is a hard gate in code** (`CRISIS_PATTERNS`,
  `agentIsCrisis` in `web/js/agentTools.js`), runs before any model call, and
  should over-trigger rather than under-trigger. Gaps are bugs.
- **Allowlist, not blocklist,** for what on-screen text may be read.
- Risk-nudge notification text says **why** by default ("You've been on
  Instagram for 22 minutes. Let's check in.") — the user's decision, reversing
  the earlier always-generic rule. A Privacy setting, "Say why on the lock
  screen" (`lock_screen_detail`, default ON), switches back to generic wording
  ("Got a second to check in?"). Either way the text **never** includes the
  matched keyword or anything that was on screen — the keyword factors only
  ever say "Something on your screen caught our attention." (fixed line, never
  AI-written). Don't loosen that.

Note: the claude.ai project's original goal doc describes "a small specialized
LLM that runs on our server" and "a machine learning model trained by user
data." The team has since decided otherwise: the chat LLM runs **on the
user's device** (no server, no Claude/Gemini), and risk scoring is
**transparent rule-based arithmetic**, not ML (one person's history is far too
small to train on). Don't reintroduce a server LLM or ML without the team
deciding to.

## 2. People, repos, and git workflow

- **Joey Lanzone** — GitHub `jlanzone21`, commits as `LANZONEJA25` /
  `Joseph Lanzone` <jlanzone21@gmail.com>. Owns the main repo and wrote most
  of the app (Android native side, tracking, risk scoring, AI agent).
- **Nathaniel Davis** — GitHub `nathanield6`, commits as `nathanield6`
  <nathanieldavis006@gmail.com>. Works on the **web version** (its
  differences from Android), YouVersion integration, the Cloudflare/site side.

Repos:

- Main: `https://github.com/jlanzone21/reclaim-app` (**private**).
- Nathaniel's fork: `https://github.com/nathanield6/reclaim-app` (**private**).
  In Nathaniel's clone: `origin` = his fork, `upstream` = Joey's repo, branch
  `master`. He keeps the fork synced with Joey's on GitHub ("Sync fork"), then
  pulls `origin` locally. Changes go back to Joey via PR from the fork.

Both repos are private — git over HTTPS needs the machine's own GitHub login
(Git Credential Manager on Windows). A sandboxed/remote shell without those
credentials can't fetch or push; that isn't a bug to work around with tokens.

### Working preferences (Nathaniel)

- **Commit after every significant change once it's been tested and confirmed
  working.** Don't wait to be asked; don't commit unverified work.
- **Don't push unless asked.**
- Commit messages follow the repo's existing style: one imperative,
  capitalized summary line (e.g. "Add nightly check-in notification",
  "Fix risk-nudge notification routing"), then a wrapped body explaining what
  and why.
- Only stage the files you changed — the working tree on Windows can show
  whole-file line-ending noise (see §3).

## 3. Machines, paths, and Windows gotchas

Both developers are on Windows. Paths differ per machine — never hardcode one
developer's path in shared config.

| | Nathaniel | Joey |
|---|---|---|
| Windows user | `DAVISTN24` | `LANZONEJA25` |
| Repo path | `C:\Users\DAVISTN24\OneDrive - Grove City College\F26\Reclaim 128\reclaim-app` | `C:\Users\LANZONEJA25\ReclaimApp\Reclaim` (not in OneDrive, on purpose) |
| Android SDK (default) | `C:\Users\DAVISTN24\AppData\Local\Android\Sdk` (unverified) | `%LOCALAPPDATA%\Android\Sdk` |

`.claude/launch.json` currently hardcodes Joey's path for the
`python -m http.server 4173` preview config — on Nathaniel's machine point
`--directory` at his own `...\reclaim-app\web`.

**OneDrive breaks the Android (Gradle) build.** OneDrive Files-On-Demand makes
every synced file an NTFS reparse point, and Gradle refuses to snapshot them
("Cannot snapshot ...: not a regular file"). Not fixable with Gradle flags.
Joey moved his copy out of OneDrive for this reason. Nathaniel's copy is still
inside OneDrive, so **Android builds will likely fail there** — web/Electron
work is fine. Fix: clone/move the repo to a non-OneDrive folder (e.g.
`C:\Users\DAVISTN24\ReclaimApp\reclaim-app`) for Android work.

**Line endings:** files are CRLF in Windows working trees (git
`core.autocrlf`), LF in the repo. If you edit from a Linux/WSL shell without
autocrlf, every file shows as modified — use
`git -c core.autocrlf=true -c core.fileMode=false status` there, and preserve
CRLF when rewriting existing files.

**Gradle/JDK (Android):**
- Needs a **JDK 21** `JAVA_HOME` for Gradle 8.14.3 (JDK 25 fails with
  "Unsupported class file major version 69"). Don't rely on Android Studio's
  bundled JBR — it moved to JDK 25 in Sept 2026. Joey uses Eclipse Temurin 21
  (`C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot`).
- "Unable to establish loopback connection" → set
  `-Djdk.net.unixdomain.tmpdir=C:\Windows\Temp` for the launcher
  (`JAVA_TOOL_OPTIONS` user env var) and daemon (`org.gradle.jvmargs` in
  `android/gradle.properties` — already set in this repo).

## 4. Layout and architecture

```
web/                 THE app. One codebase shipped by Electron, Capacitor
                     (Android), and the website. Edit here.
  index.html         All views + the <script> load order.
  css/styles.css     All styling (navy #06335d / orange #fe8722 palette).
  js/                One classic-script module per file (see below).
  js/vendor/         Vendored libs: sql-wasm.js/.wasm, web-llm.js (6 MB),
                     youversion-platform.js. Generated — don't hand-edit.
  assets/            Icons.
main.js              Electron entry (loads web/index.html from file://).
capacitor.config.ts  Capacitor (appId com.reclaim.app, webDir web).
android/             Capacitor Android project + native Java plugins.
scripts/             vendor-webllm.mjs, vendor-youversion.mjs,
                     export-seed-sql.mjs, import-small-groups.mjs, make-icons.mjs
extension/           Local-only Chrome/Edge extension: web-version site tracking,
                     risk scoring (port of RiskScorer) and notifications. See README.
supabase/            migrations/ (applied), seed.sql, checkins_design.sql (NOT applied)
wrangler.jsonc       Cloudflare static-assets deploy of ./web (reclaim128.org).
branding/, build/    Logo and Electron icons.
README.md            How the code works (long, accurate — read it).
PURPOSE.md           Why + roadmap checklist + decisions log (read it).
```

**The #1 code rule: no build step.** `web/` loads only plain classic
`<script>` tags (Electron opens it from `file://`, which rules out ES module
imports of npm packages). Every JS file is an IIFE exposing a global
(`const HomeView = (function () { ... return {...}; })();`). Order in
`index.html` matters — dependencies load first. npm libraries are bundled into
a single global script under `web/js/vendor/` by a `scripts/vendor-*.mjs`
script with the version pinned in `package.json` (see web-llm and YouVersion).
Never add a bundler, framework, or `type="module"` import of npm code.

Main JS modules (`web/js/`):

- `app.js` — boot, navigation, chat UI, `renderToolResult` (resource cards),
  welcome/disclaimer (`WELCOME_VERSION`, currently "3" — bump to re-show).
- `db.js` — sql.js SQLite, schema, `migrateColumns()`, persistence as a base64
  blob in `localStorage`. `CURRENT_SEED_VERSION` (currently 8).
- `seedData.js` — bundled local content (scripture, devotionals, bible plans,
  coping mechanisms). Much is placeholder (`is_sample: 1`, shown with a
  "Sample" tag).
- `resourceRepo.js` — query layer (`getScripture`, `getDevotional`,
  `getSmallGroups`, …). `supabaseClient.js` — tiny fetch-based read-only
  Supabase REST client.
- `agentTools.js` — shared tools, keyword routing (`AGENT_TOOL_DEFS`,
  `AGENT_THEME_WORDS`, `agentPickResource`), `AGENT_SYSTEM_PROMPT`,
  `executeAgentTool` (single source of truth for tool output), crisis check.
- `fixedAnswers.js` — reviewed, fixed replies for app/privacy questions and
  requests to find or excuse porn; runs right after the crisis check, before
  card routing or any model call, in both agents. Add an intent there instead of
  trusting the model with a factual claim about the app.
- `reclaimAgent.js` — the on-device AI agent. `resourcesAgent.js` — "Basic
  mode" scripted fallback (no model). `localModel.js` — WebLLM loading.
- `personalContext.js` — builds the per-turn context sentences from
  check-ins and preferences.
- `checkinStore.js`, `checkinView.js`, `insightsView.js`, `charts.js`,
  `homeView.js`, `preferencesView.js`, `userPreferencesStore.js`,
  `permissionsView.js`, `allowlistView.js`, `riskAlertView.js`,
  `riskProfile.js`.
- `native*.js`, `localSignals.js`, `backgroundSampler.js`, `nearbyDevices.js`
  — JS bridges to the Android plugins (no-ops elsewhere; check
  `LocalSignals.available()`).
- `youversion.js` — YouVersion Bible display (§7).
- `debugTestPanel.js` — **TEMPORARY** testing panel (§9).

## 5. Data

- **Local (sql.js, `db.js`):** resources (scripture, devotionals, bible
  plans, coping mechanisms), `bible_plan_days`, `checkins`,
  `user_preferences`, `app_meta`.
  - **Bump `CURRENT_SEED_VERSION` whenever `seedData.js` changes
    materially**, or existing installs never see it. A bump replaces
    `is_sample=1` rows only; never touches check-ins or `is_sample=0` rows.
  - **sql.js gotcha:** multi-statement DDL must use `db.exec()`, not
    `db.run()` (`run` silently executes only the first statement).
  - New columns on existing tables need `migrateColumns()` (`PRAGMA
    table_info` then `ALTER TABLE ADD COLUMN`).
  - Everything waits on async `DB.init()` at startup.
- **Supabase** (`https://hdymcreqtwcwgwftglox.supabase.co`): read-only
  public resource library — small groups (38 real), sermons, articles,
  counseling centers. RLS grants only `select` to anon. The **publishable
  key** in `supabaseClient.js` is meant to ship; the **`service_role` key
  must never be in the app or repo.** No on-device fallback for these —
  functions resolve `null` when unreachable and the UI says so. Accounts +
  check-ins in Supabase (anonymous auth, RLS) are designed in
  `supabase/checkins_design.sql` but **not started/applied**.
- **Android native (`LocalSignalsDb`, SQLite):** passively collected signals
  (usage samples, app-open events, keyword matches, notification identity,
  location, nearby devices) and `app_meta` mirrors (risk context,
  `pending_risk_alert`). Read in JS via `LocalSignalsPlugin`/`localSignals.js`.
  Never networked.
- Every resource tool returns **at most 2** results per request (user ask —
  a long list overwhelms someone mid-urge).

## 6. The AI agent (on-device)

- Model: **Qwen3.5-2B** (`Qwen3.5-2B-q4f16_1-MLC`, ~1 GB) via WebLLM +
  WebGPU, downloaded only after the user taps to opt in. 4k context,
  temperature 0.3, thinking off. (4B was tried on-device and reverted.)
- Flow per message: crisis gate → **fixed answers** (`fixedAnswers.js`) → **keyword routing** picks at most one
  resource card (no model call — a model-based pick took ~16 s on a Pixel 8a)
  → app renders the card and writes its one-sentence intro, and **that is the
  whole reply (no model call)**; with no card the model writes 1–2 sentences
  as a resource finder that doesn't answer questions or give advice/theology
  → each sentence is filtered (`RECLAIM_UNSAFE_SENTENCE`: Bible references,
  quoted passages, phone numbers, links, verse offers, and known tone failures
  are dropped). Don't put example sentences in `AGENT_SYSTEM_PROMPT`: the
  small model copies them as its default reply. `CRISIS_PATTERNS` lives in
  `resourcesAgent.js` (shared with Basic mode via `agentIsCrisis`).
- **The model must never quote, name, or list a verse or resource** — small
  models invent scripture and organizations. The app shows the real thing;
  the model only points toward it.
- **Never edit `modelHistory` between turns** and keep the system prompt
  identical every turn (per-turn notes go in the user message) — that's what
  lets WebLLM reuse its KV cache (~6 s vs ~16 s on a phone).
- `ResourcesAgent` (Basic mode) must call the shared `executeAgentTool` for
  data — a duplicated copy once caused a fix to silently not reach Basic mode.
  When a tool's output shape changes, update **both** `app.js`
  `renderToolResult` and `resourcesAgent.js` reply text.
- **The AI also explains risk nudges** (`riskExplainer.js`), grounded in
  RiskScorer's **trace** (every factor, fired or not, with its values — see
  RiskScorer.java "Explainability"; mirrored in `extension/lib/riskScorer.js`).
  Three jobs: (1) the note at the top of the alert screen; (2) reading the
  user's own words about whether a nudge was fair into a *proposed* verdict that
  the user confirms before the existing bounded ±2 weight nudge runs
  (`recordRiskFeedback` / extension `RISK_FEEDBACK`) — the model never moves
  weights itself, and its factor picks are re-validated against what actually
  fired; (3) writing phrase templates ({app}/{minutes}/{time}) ahead of time,
  because the model can't run while the app is closed — native
  `RiskNotificationText.java` / `extension/lib/notificationText.js` (keep the
  two in step) fill in live values when a notification fires. Every model output
  is checked in code and falls back to a deterministic template; the trace holds
  no screen text. The free-text feedback box runs the crisis gate first.
- Setup answers (accountability partner(s), pastor, tempting times, triggers)
  reach the prompt via `personalContext.js`; the prompt tells the model to
  name the partner. Up to 2 accountability partners
  (`accountability_name/_phone` and `_2`).

## 7. Scripture and YouVersion

- Verses are shown with the **YouVersion Platform** Bible display
  (`web/js/youversion.js`, SDK `@youversion/platform-core` 2.15.0 bundled to
  `web/js/vendor/youversion-platform.js` by `npm run vendor:youversion`).
- **App Key** is `APP_KEY` in `youversion.js` (from platform.youversion.com;
  a client-side app identifier, fine to ship). API header `X-YVP-App-Key`.
- **Version:** NIV (id 111) preferred — licensed for this key (verified live
  2026-09-30). BSB (3034) is the automatic fallback if YouVersion answers
  403 for NIV. Other English versions the key can use: ASV 12, CPDV 42,
  FBV 1932, LSV 2660, WEB 206, WMB 1209, etc.
- Home's card is **"Today's Verse"** = YouVersion Verse of the Day
  (`getVOTD(dayOfYear)`, local time zone). In Chat, a plain "share a verse"
  shows today's verse; a detected theme (shame, loneliness, …) shows the
  seeded verse for that theme, fetched from YouVersion by reference
  (`referenceToPassageId`: "Psalm 139:23-24" → `PSA.139.23-24`).
- **License requirement:** always render the version's copyright attribution
  with the text (`render()` does this). Keep the passage HTML inside the
  `data-slot="yv-bible-renderer"` container so YouVersion's CSS applies.
- Everything falls back to the local `seedData.js` verse text when there's no
  key, no network, or an API error — never an empty verse card.
- The imported content bundle's 511 scripture references were deliberately
  **not** imported (NIV text was the licensing blocker). YouVersion now
  solves that — importing them as references-only is a possible follow-up,
  but ask first.

## 8. Android native side

**Full-screen check-in** (`RiskOverlay.java`): on EVERY risk nudge, if the person has
granted "Display over other apps" (`SYSTEM_ALERT_WINDOW`; a Privacy card sends them
to the Settings page — the grant IS the consent, no separate toggle), a native
overlay window covers whatever is on screen with: the same specific sentence as
the notification, the plain-language reasons (ALWAYS shown, so people can judge a
false alarm themselves — there is deliberately no "why" button), Call <partner>,
Read a verse, "I'm okay" (5 s wait), and small underlined text links at the bottom:
"This was a false alarm". (A 988 link was there and was removed at the user's
request; while the overlay is up it covers the app's own crisis button, so the
only ways out are "I'm okay", the flag page, Home, and the failsafe.) **Default verdict is
"fair"**: any way of answering the main screen reinforces the factors that fired
(bounded ±2 via `RiskScorer.applyFeedback`, once per alert id); only the flag link
changes that. It opens a second page: tap which parts didn't fit and/or type why,
Send — or Skip, which still counts as a false alarm on everything that fired. Picked
reasons / Skip adjust immediately; typed words with no reasons picked wait in
`RiskFeedbackNotes` for the on-device AI (the overlay can't run the model), which
on the next app open asks one YES/NO per fired factor ("does this person say THIS
part was wrong?") and applies the false alarm to the YES factors (all fired if none /
no model), then keeps the note as context for the chat model
(`RiskExplainer.processFeedbackNotes` / `feedbackContext`). The crisis gate runs
before any model call on typed words. Unreinforced timeouts record nothing. Known
tradeoff: because unflagged nudges now count as "fair", weights drift upward over
time (bounded at 1.5× default); watch for it. It is an overlay window, not an activity, on
purpose: Android 10+ blocks background activity starts, full-screen intents are
denied to non-call apps on 14+, and 15+ narrowed the overlay exemption — verified
on the Pixel 8a (Android 16) that the notification's `setFullScreenIntent` is
`FSI_REQUESTED_BUT_DENIED` and that the overlay survives Back and Home and covers
Chrome. Android gives no way to disable Home/Recents, so it is never "inescapable":
Back is swallowed, Home leaves it up, and it has a hard 10-minute failsafe, and dies
instantly if the permission is revoked. Scripture is deliberately not
embedded yet (an embedded AI scripture feature is planned; "Read a verse" only
routes to the existing verse flow). Don't add a way to make it unescapable.

Java in `android/app/src/main/java/com/reclaim/app/`: `MainActivity`,
Capacitor plugins (`LocalSignalsPlugin`, `AccessibilityPlugin`,
`UsageStatsPlugin`, `NotificationAccessPlugin`, `NotifyPlugin`,
`NearbyDevicesPlugin`, `LocationAlwaysPlugin`, `BackgroundSamplerPlugin`),
`LocalSignalsDb`, `TrackingAccessibilityService` (app-open events +
allowlisted text capture), `RiskNudgeMonitor` + `RiskScorer` (weighted
risk score vs. a threshold set by notification intensity low 90 / medium 60 /
high 35; adaptive weight tuning), `NightlyCheckinWorker` (~9:30 pm),
`BaselineSampleWorker`, `ForegroundAppMonitor` (debug tool),
`RecentNotificationListenerService`.

Build and install (from the repo root, **not inside OneDrive**):

```
npx cap sync android              # after ANY change under web/
cd android
.\gradlew.bat assembleDebug       # -> android\app\build\outputs\apk\debug\app-debug.apk
.\gradlew.bat assembleRelease     # -> ...\apk\release\app-release.apk
& "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe" install -r <apk>
```

- **Release vs debug signing:** release is signed with
  `android/app/reclaim-release.keystore` (passwords in
  `android/keystore.properties`; both gitignored — never commit, back the
  keystore up). A debug APK can't install over the release app, and
  uninstalling wipes the phone's check-ins — only use debug builds on a phone
  without real data.
- Debug a WebView: debug build + USB debugging → `chrome://inspect` in
  desktop Chrome. The devtools bridge gets throttled when the app is
  backgrounded.
- Test device so far: Pixel 8a (WebGPU works in its WebView).

## 9. Boundaries and known history

- **Claude Code's safety checks have blocked, repeatedly and structurally:**
  writing `accessibility_service_config.xml` widening, the tracking logic in
  `TrackingAccessibilityService.java`, and `adb install` of the result. Joey
  made those edits and ran the install himself. If you hit a block like this,
  surface it — don't reword, retry, or route around it via another tool.
- **Testing panel is TEMPORARY** (`debugTestPanel.js` + `TEMPORARY` blocks in
  `LocalSignalsPlugin.java`, `RiskNudgeMonitor.java`, `localSignals.js`).
  Remove it before any real user gets the app.
- `ForegroundAppMonitor` still has a known latent dedup-before-permission bug
  (debug-only, intentionally untouched).
- `nearby_device_bucket` exists but is never populated — don't build on it.
- Sample/placeholder content (`is_sample: 1`, fake (555) numbers, invented
  authors) must be replaced with real, rights-cleared content before launch.
- Content sourcing: research real resources live (not from memory), prefer
  `verification_status: "public_source_only"` in `details`, and avoid
  sources with serious credibility problems (e.g. Matt Chandler / The Village
  Church was deliberately excluded).

## 10. Documentation habits

- When a feature lands or a real decision is made, add a `- [x] **Bold
  summary.**` entry to PURPOSE.md's checklist (before the "Allowlist, not a
  blocklist" decisions list), in the existing voice: what was asked, what was
  built, tradeoffs, and **how it was verified** (on-device vs browser vs
  mocked). Update README.md when how the code works changes.
- Code comments explain *why* (history, tradeoffs, what broke before), not
  just what. Match that style.
- Say plainly what's verified and what isn't. "Builds clean" is not
  "works on the phone."

## 11. Running it

- Web: serve `web/` statically (e.g. `python -m http.server 4173 --directory
  web`) and open `http://localhost:4173`. Native features no-op in a browser.
- Desktop: `npm install` then `npm start` (Electron). `npm run dist` builds
  a Windows installer into `dist/`.
- Website: `wrangler.jsonc` deploys `./web` as Cloudflare static assets;
  domain `reclaim128.org` (Cloudflare, Nathaniel's).
- Usage dashboard: `wrangler.analytics.jsonc` deploys `./analytics-site`
  (one page) as its own separate Worker, `reclaim-analytics` -- separate
  from the main site's worker so a custom domain pointed at it shows only
  the dashboard, not the whole app. One-time setup (needs Nathaniel's
  Cloudflare access, same as the main site): `npx wrangler deploy --config
  wrangler.analytics.jsonc`, then in the Cloudflare dashboard, Workers &
  Pages > reclaim-analytics > Settings > Domains & Routes > Add > Custom
  Domain > `analytics.reclaim128.org` (auto-creates the DNS + SSL cert).
  After that, `npx wrangler deploy --config wrangler.analytics.jsonc`
  alone redeploys it. Passcode-gated (see PURPOSE.md); change it with
  `UPDATE app_settings SET value = '...' WHERE key = 'analytics_passcode'`
  in the `reclaim-128` Supabase project.
- Regenerate vendored libs: `npm run vendor:webllm`,
  `npm run vendor:youversion`.
- **Distributing a debug build to testers (Firebase App Distribution,
  project `reclaim-128`):** one-time per machine --
  `npm install -g firebase-tools` then `firebase login` (your own Google
  account, interactive browser login; do this yourself, never have an
  agent do it). After that: `cd android && ./gradlew assembleDebug
  appDistributionUploadDebug`. Testers (both of you) are listed directly
  in `android/app/build.gradle`'s `debug.firebaseAppDistribution` block,
  not a console-side group -- add more emails there as the project grows.
  `android/app/google-services.json` is committed (it's a public client
  config, not a secret -- standard Firebase practice); the keystore/
  signing secrets it's *not* are still gitignored as before.

## 12. Neighboring folders (not this repo)

In Nathaniel's `Reclaim 128` folder, next to `reclaim-app`:

- `Reclaim-128/` — Joey's separate `jlanzone21/Reclaim-128` repo (Python).
- `data-collector/` — Nathaniel's browser extension
  (`nathanield6/reclaim-128-data-collector`) that records browsing sessions
  for topic-modeling research; separate consent and privacy scope.
- `site/` — static site files and the beta tracker zip.
- reclaim-beta (Joey's tester data-collection app) has a narrow promised
  scope (browser domain only) — broader capability belongs here, not there.

Planned/considered infrastructure (not built): a Node.js backend hosted on an
always-on MacBook Pro, with Supabase for the database and user info.
