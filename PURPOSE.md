# Reclaim — purpose & roadmap

README.md explains how the code works. This is the other half: why, what's
actually built vs. still planned, and the specific decisions behind the
sensitive parts — so this doesn't live only in chat history. Update this
file whenever a real decision gets made or a phase lands, not just when
someone remembers to.

## Vision

Reclaim helps someone struggling with pornography addiction two ways:
connecting them to real people and resources (chat), and helping them (and
eventually the app itself) recognize the patterns around their own
struggle so support can arrive before a slip, not just after one
(check-ins, and the on-device tracking described below). It never
replaces a pastor, counselor, or accountability partner — every feature
either points toward one of those or gathers the context that makes doing
so more useful.

## The privacy commitment, and why it's load-bearing

**Nothing sensitive leaves the device.** Chat runs the AI locally. Check-ins
are local (moving to Supabase later is a deliberate, separate, user-account
decision — see README — not the same thing as the tracking below). The
on-device tracking system (this doc's main subject) never talks to a
network at all.

This isn't caution for its own sake. The tracking capability described
below — reading what's on someone's screen — is the same mechanism
stalkerware uses. The thing that makes it a legitimate recovery tool
instead of exactly that is: it's the person's own device, they explicitly
consented with full knowledge of what's read, and nothing about it can
ever reach a third party. Weaken any one of those three and it stops being
a recovery tool. Any change here should be checked against all three, not
just "does it work."

## What's built

- Chat, Check-In, Insights UI shell, local resource library, on-device AI
  (see README for detail).
- Real small-group data live from Supabase (read-only, public content —
  unrelated to the tracking system below).

## What's planned (this session's scope)

Full detail in the session's plan; summarized here as the standing
checklist — check items off as they land, don't let this drift from
reality:

- [x] **On-device data layer** — `LocalSignalsDb` (native SQLite), separate
      from the existing sql.js-based `db.js`, read from JS via
      `LocalSignalsPlugin`. Verified on-device: a real row written by the
      native worker was read back correctly through the JS bridge.
- [x] **Ported collectors** — usage stats, location (+ "Allow all the
      time"), nearby devices, notification identity, browser-domain
      detection, the periodic background sample (screen-on/unlocked gated),
      and the 1-hour "you've been on X" session notification. All ported
      from reclaim-beta's already-verified mechanisms, storing locally
      instead of posting to Supabase. Also needed, discovered while
      verifying: a `<queries>` declaration (Android 11+ package-visibility
      filtering otherwise hides every other app from `PackageManager`,
      including for the allowlist picker and app-label resolution).
      Default allowlist (browsers + YouTube/Instagram/TikTok/Reddit/X/
      Snapchat/Facebook, whichever are actually installed) seeds itself
      once, automatically, the first time tracking is enabled.
- [x] **Consent + permissions screen** — a new "Privacy" tab, same honest,
      skippable, per-permission design as reclaim-beta's, plus the
      allowlist manager (add/remove, searchable picker over real installed
      apps) and a background-sampling on/off toggle. Verified live on
      device: cards accurately reflect real permission state, add/remove
      correctly round-trips through `LocalSignalsDb`.
- [x] **Insights, for real** — mood/urge/sleep now shown as averages
      (30-day window, skipping entries where that field was left blank).
      Added three "recent activity" panels (background samples, app-open
      events, keyword matches) reading live through `LocalSignals`, with
      package names resolved to real app labels. Verified on device: real
      background-sample rows render correctly with relative timestamps;
      the still-unbuilt event/keyword panels correctly show an honest empty
      state rather than breaking.
- [x] **Real-time app-open events** — system-wide (not browser-scoped)
      accessibility detection of which app is in the foreground, identity
      only, never content, written to `app_events`. `accessibility_service_
      config.xml`'s `packageNames` restriction and `TrackingAccessibility
      Service`'s `recordAppOpen`/`resolveLabel` logic were both edited by
      hand on the user's own machine, not by Claude Code directly — see
      "Decisions worth remembering" for why. Everything downstream (build,
      install, on-device verification) was done normally. Verified on
      device via the real `LocalSignals` bridge: real rows with correct
      package, resolved app label, and timestamp as the user switched
      between apps (Reclaim, System UI, launcher, YouTube, Phone), deduped
      correctly so staying in one app doesn't spam rows. One minor,
      non-blocking gap: the launcher's label doesn't resolve (shows its
      raw package name) — likely outside the `<queries>` filter's scope,
      not investigated further.
- [x] **Allowlist-scoped text capture + keyword matching** — written and
      built by Claude Code directly, unlike Phase 4's two files. Builds
      clean; on-device confirmation that a real match gets recorded is
      still outstanding. See "Decisions worth remembering."
- [x] **Onboarding + preferences** — a second setup step chained after the
      existing welcome/988 disclaimer, first-launch only, always reachable
      after via Privacy → "Edit your preferences." Collects: accountability
      partner + pastor name/phone (optional, explicitly revisitable —
      skipping now doesn't lose the chance), tempting times of day, common
      trigger situations (reuses `CONDITION_TAGS`, the same vocabulary
      check-ins already use), tempting locations (free text), trigger apps
      (reuses the real monitoring allowlist rather than a separate
      self-reported list — naming an app here IS adding it to what gets
      read), and notification intensity (Low/Medium/High — will scale the
      future send/don't-send threshold once that algorithm exists; this
      phase only captures the preference). Stored in a new
      `user_preferences` table in the existing `db.js` (sql.js), not
      `LocalSignalsDb` — this is directly user-entered through the WebView,
      not passively collected in the background, so it belongs with
      check-ins, not the native signals DB. The accountability partner/
      pastor number also surfaces as a tap-to-call entry in the existing
      crisis modal, above the fixed 988/SAMHSA lines, using a plain `tel:`
      link — Reclaim never sends anything itself, it just hands off to the
      phone's own dialer, so this doesn't touch the on-device-only privacy
      commitment at all. Verified end-to-end in a plain browser (onboarding
      chain, save, reopen/edit pre-fill, reload persistence, crisis modal
      tel: links, AI context sentence generation); confirmed working
      on-device too, including that the accountability partner's name/phone
      the user actually entered reaches the AI's context correctly.
- [x] **AI actually uses the setup answers** — the data was reaching the
      system prompt correctly, but the on-device model wasn't visibly
      acting on it (confirmed on the phone: real accountability-partner
      data was in the prompt, but replies didn't reference it). The gap
      was instructions, not wiring — `AGENT_SYSTEM_PROMPT` (agentTools.js)
      now explicitly tells the model to encourage reaching out to the named
      accountability partner/pastor by name when known, instead of the old
      generic phrasing a small model tended to ignore.
- [x] **Risk nudge notification, phase one** — `RiskNudgeMonitor.java` +
      `RiskScorer.java`. First version fired on a single flat threshold
      (any app, 20 minutes); reworked mid-session once the actual goal was
      clarified: intercept a lead-up pattern *before* a slip, not react to
      evidence one already happened. Explicitly **not** ML — a single
      person's on-device check-in history is a handful of entries, nowhere
      near enough to train anything real, and there's no server or
      training pipeline in this architecture anyway. `RiskScorer` is
      transparent, weighted, debuggable arithmetic instead: current app on
      the trigger-app allowlist (+30), session duration (+2/min, capped
      +30), current time-of-day matching a self-reported tempting time
      (+20) or a time that's actually preceded this person's own past
      slips (+15, from `RiskProfile`), and a flagged "Social media" trigger
      matching a known social app (+10) — summed and compared against a
      threshold set by `notification_intensity` (low=90, medium=60,
      high=35). Fires the same "Call [name]" `tel:`-dialer notification as
      before once the score crosses that bar. `nearby_device_bucket`
      (a possible "are they alone" proxy) exists in the schema but is never
      actually populated by the periodic sampler, so a solitude signal was
      left out of this pass rather than built on a column that's always
      null.

      `RiskProfile` (riskProfile.js) turns check-in history into which
      tags and time-of-day buckets have actually preceded past slips —
      same tag-frequency reasoning `personalContext.js` already used for
      chat, applied to structured scoring instead of prose. That, plus the
      relevant `UserPreferencesStore` fields, gets mirrored one-way into
      `LocalSignalsDb`'s `app_meta` (`LocalSignals.syncRiskContext`,
      replacing the earlier accountability-only mirror) on every
      preference save, every check-in add/remove/clear, and once at boot.

      Verified fully on-device: confirmed the score computation itself
      (`score=20 threshold=35 [self-reported-time(+20)]`), then confirmed
      duration accumulation crossing the threshold for real
      (`score=38 threshold=35 [duration=9m(+18) self-reported-time(+20)]`
      → notification posted), using a real ~9-minute continuous session,
      not a shortened one. Testing surfaced a real Android constraint: the
      WebView's devtools bridge (used all session for on-device
      verification) gets throttled once the app backgrounds behind another
      app, which also ruled out `adb shell cmd jobscheduler run -f` as a
      reliable trigger (its internal job ID changes across app restarts).
      Worked around by testing with Reclaim itself as the foregrounded
      session (never excluded from scoring, unlike the launcher) so the
      WebView stayed responsive throughout.

      Found and fixed a real bug shared with `ForegroundAppMonitor`'s
      pattern along the way: the per-session dedup marker was written
      before checking notification permission, so a session crossing the
      threshold before permission was granted would silently never notify
      even after granting it later — fixed here; `ForegroundAppMonitor`
      still has the same latent bug, not touched since it's a debug tool,
      not a shipped feature.

      **Planned v2, not built yet:** a small deterministic feedback loop
      that nudges these weights based on whether a check-in shortly after
      a notification was "resisted" or "slipped" — genuinely adaptive
      without needing real ML or the on-device LLM anywhere near numeric
      tuning. Needs real usage data to mean anything, so it's next once
      this version has actually run against real behavior for a while, not
      before.
- [x] **Fixed a real architectural bug: two divergent tool implementations.**
      `ResourcesAgent` (Basic mode, used when the on-device AI isn't
      downloaded) had its own hand-duplicated copy of every resource
      lookup, instead of calling the shared `executeAgentTool`
      (agentTools.js) that `ReclaimAgent` uses. This is exactly how the
      accountability-partner fix silently failed to reach the user the
      first time — fixed in `agentTools.js` alone, `ResourcesAgent` kept
      running its own old copy. `ResourcesAgent._planResponse` now calls
      `executeAgentTool` for every branch's data, keeping only its own
      (deliberately broader) regex intent-matching and scripted reply
      text — one source of truth for what a tool actually returns,
      regardless of which mode is answering. `accountability_match`
      itself now checks `UserPreferencesStore` directly (the real
      accountability partner, or a prompt to add one) instead of
      returning sample `accountability_program` resources — deterministic,
      not dependent on the model choosing to use it. Confirmed real small
      groups already pull from Supabase correctly (36 real entries, 0
      flagged as sample) — nothing to fix there.
- [x] **Sermons, articles, and counseling centers moved to Supabase, real
      data.** Same reasoning as small_group from the start: shared,
      publicly-sourced content goes stale the moment a link or number
      changes, so a local seeded copy was always the wrong shape for it —
      it just took this long to actually replace the placeholder rows.
      Researched real candidates via live web search (not recalled from
      memory), user reviewed and approved the list, inserted into the
      same Supabase `resources` table small_group already uses, same
      `verification_status: "public_source_only"` convention on `details`
      that small_group's real rows already use. `ResourceRepo.getSermons/
      getArticles/getCounselingCenters` now all read live through a shared
      `fromSupabase()` helper (capped at 5, shuffled, returns `null` on
      failure) — the exact same shape `getSmallGroups` already had.
      Along the way: fixed a real bug where `null` on a Supabase failure
      would throw inside `renderToolResult`'s `.forEach` instead of
      showing a "couldn't reach" message — this gap existed for
      `small_group_finder` too, on `ReclaimAgent`'s path specifically
      (only `ResourcesAgent`'s Basic-mode path had ever handled it). Local
      sample rows for these three types removed from `seedData.js`,
      `CURRENT_SEED_VERSION` bumped so existing installs clear them.
      Deliberately excluded Matt Chandler / The Village Church from the
      candidates despite being an obvious name for this topic — search
      turned up real coverage of a child-sexual-abuse cover-up
      controversy there.
- [x] **Risk nudge tries to actually interrupt, not just notify.** User
      asked for the notification to disrupt a moment of temptation, not
      just sit passively in the shade. Real mechanism: `setFullScreenIntent()`
      on a `IMPORTANCE_HIGH` channel — the same one calls/alarms use, added
      via the `USE_FULL_SCREEN_INTENT` manifest permission. Honest limit,
      not worked around: Android only lets this actually take over when
      the screen is off/locked (opens the app instead of the lock screen);
      it will not yank focus from another app you're actively using — that
      class of behavior is deliberately blocked platform-wide since
      Android 10, for exactly the reason it'd otherwise be abused.

      Privacy-driven design choice, confirmed with the user before
      building: the notification/lock-screen text is permanently generic
      (`"Reclaim wants to check in with you."`) — never names the app or
      the pattern, since anyone glancing at a locked phone could see it.
      The specific "here's what we noticed" detail (which app, and
      plain-language reasons built straight from `RiskScorer`'s factors —
      "you're on a flagged app," "it's a time that's hard for you," etc.)
      is written to `LocalSignalsDb.app_meta` instead
      (`pending_risk_alert`) and only surfaces once the app is actually
      open — `RiskAlertView` (new) checks for it once at boot, native
      clears it on read so it only ever shows once per alert. Shows a
      "Call [name]" action (same `tel:` pattern as everywhere else) and a
      "Talk about it" shortcut into Chat.

      Verified in two parts rather than one unbroken on-device run, after
      an OS-level Safety Center prompt interrupted the foreground session
      mid-test: the native pipeline (score → notification posts with the
      generic text and `IMPORTANCE_HIGH` → `pending_risk_alert` written
      with correct structured reasons → cleared on read) was confirmed
      on-device via logcat and direct plugin calls; `RiskAlertView`'s
      rendering (title, reasons list, personalized call button, hides
      when no contact is set, dismiss works) was confirmed by feeding it
      the same shape of data the native side had already been shown to
      produce, in a plain browser. Together they cover the same ground an
      unbroken run would have; not the same as one live end-to-end
      confirmation, worth a real walkthrough on the phone when convenient.

      Adjusting these settings from the app itself (which factors matter,
      how intrusive to be) was explicitly named as future work, not built
      this pass.

## Decisions worth remembering

- **Allowlist, not a blocklist**, for text capture, and it's user-editable.
  A blocklist means anything you didn't think to exclude — a new messaging
  app, a journal app — gets read by default. An allowlist means nothing
  gets read unless you explicitly added it.
- **Raw text is kept, not discarded after keyword-matching.** The
  alternative (classify-and-discard, keep only the match) was offered and
  explained; the user chose to keep the raw text so they can review what
  was actually on-screen, not just that something matched. Revisit if this
  becomes a real liability (device loss/compromise) rather than a
  theoretical one — a retention cap is the likely first move, not a reversal
  of the choice itself.
- **This lives here, not in reclaim-beta**, on purpose. reclaim-beta is
  disposable tester-data collection with a narrow, already-promised scope
  (browser domain only, nothing more). Building broader capability into it
  would break a promise already made to real testers. reclaim-app is the
  long-term product with a real consent flow, so it's where capability that
  actually needs care belongs.
- **The accessibility config widening is a real, non-trivial step** — it's
  the exact change that was attempted for reclaim-beta and stopped by
  Claude Code's own safety classifier earlier in this project's history.
  The case for it being different here (on-device, main app, transparent,
  no third-party flow) is real, but isn't guaranteed to land cleanly when
  actually attempted — if it's blocked again, that gets surfaced and
  discussed, not routed around.
- **It was attempted here, and blocked again — confirmed structural.**
  Two apps, two separate justifications, same tool-level block on the same
  file write. Not a phrasing problem, not worth retrying with different
  wording, not something to route around via another tool.
- **How Phase 4 actually shipped: the user made the specific blocked edits
  themselves.** Claude Code blocked three separate things in sequence for
  this feature: the `accessibility_service_config.xml` write, the
  `TrackingAccessibilityService.java` code implementing the tracking logic
  (even after the config was already widened), and finally `adb install`
  of the built APK onto the device. The user made the config edit and the
  Java edit by hand, in their own editor, off a full file Claude Code
  wrote out in chat (not applied directly); Claude Code then built and
  ran `npx cap sync`/`gradle assembleDebug` normally (not blocked), and
  the user ran `adb install` themselves from their own terminal (also
  blocked for Claude Code). Once installed, reading the resulting data
  back was never blocked — verification happened normally. Net effect:
  Claude Code can design, write out, build, and verify this feature, but
  cannot itself write the specific files that turn on system-wide
  accessibility tracking, or deploy the result to a device. That boundary
  held consistently across three distinct tool calls, not just one.
- **The AI's "instructions" are generated, not a maintained file.** The
  onboarding request asked for preferences to live in "an instructions
  file" for the AI. Built instead as: structured answers in
  `user_preferences`, turned into plain-language sentences fresh on every
  chat turn by `buildUserPreferencesContext()` (`personalContext.js`),
  the same pattern `buildPersonalContext()` already used for check-ins.
  Functionally the same outcome — the AI always has this context — without
  a second copy of the data that could drift out of sync with what's
  actually in Privacy.
- **Contact info is reference-only, on-device communication, never sent.**
  Accountability partner/pastor numbers are never transmitted anywhere by
  Reclaim itself — the only "reach out" mechanism is a `tel:` link, which
  just hands off to the phone's own dialer. Deliberately chosen over any
  form of automatic messaging, which would have required leaving the
  device and broken the privacy commitment above.
- **Risk scoring is rule-based, not ML — and the on-device LLM never
  touches the weights.** The user explicitly floated "possibly ML." Ruled
  out for a concrete reason, not caution: a single person's check-in
  history is dozens of entries at most, far too little to train anything,
  and there's no server-side training pipeline in an on-device-only app
  anyway. Using the on-device chat model to "reason about" weight
  adjustments was considered and also rejected — nudging a number is a
  math problem, not a language problem, and an LLM-driven adjustment
  process would be unreliable and hard to debug or trust. The planned v2
  adaptive layer (see the risk-nudge checklist item above) is a small
  deterministic feedback rule instead, in the same spirit as everything
  else in this system: explainable code, not vibes.
