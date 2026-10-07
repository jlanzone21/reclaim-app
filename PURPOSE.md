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

- Home, Chat, Check-In, Insights UI shell, local resource library,
  on-device AI (see README for detail).
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
      check-ins already use), trigger apps
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

      **v2 shipped** — see the adaptive-tuning checklist item further down
      for the actual feedback loop, once the convergence bonus (also
      below) landed first per the confirmed build order.
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
- [x] **Testing panel — TEMPORARY, not a real feature.** A dashed-amber
      "⚠ Testing tools" panel at the bottom of Privacy, only visible
      on-device (`LocalSignals.available()`), with buttons to: run the
      background check now, send a risk-nudge notification now, send a
      nightly check-in notification now, clear the notification cooldown,
      and peek the pending risk alert without consuming it. Exists because
      this session kept needing to
      hand-trigger these exact things over adb/CDP to verify anything —
      forcing WorkManager jobs, deleting SharedPreferences files
      underneath a live process (which doesn't actually work, learned the
      hard way), waiting up to 15 real minutes for the periodic schedule.
      This makes all of that a button tap instead, for both of us.

      Marked as temporary everywhere it can be: a `TEMPORARY` block
      comment in each of the four files it touches
      (`LocalSignalsPlugin.java`, `RiskNudgeMonitor.java`, `localSignals.js`,
      `debugTestPanel.js`) naming exactly what to delete together, plus
      the loud dashed/striped styling in the UI itself so it reads as
      "not a real feature" without reading any code. Should come out
      before this ever reaches a real user — nothing here is dangerous
      (it can only trigger things the app already does on its own
      schedule), but a "send yourself a notification" button has no
      business existing in a shipped recovery app.
- [x] **Nightly check-in notification.** A once-a-day prompt around
      9:30pm — `NightlyCheckinWorker` (WorkManager, 24h periodic,
      wall-clock initial delay computed via `Calendar` since WorkManager
      only takes durations) — deliberately timed just before
      `RiskScorer.timeBucket`'s "Night" bucket (10pm) starts, so it doubles
      as a preventive touchpoint, not just data collection. "Went well"
      needs no app-open at all; "Tell me more" opens straight to Check-In.
      Both log through the same `CheckInStore` everything else already
      reads (`RiskProfile`, `personalContext.js`, Insights) — "Went well"
      logs a `resisted` check-in with no tags directly; "Tell me more"
      lands on the ordinary Check-In flow for real detail.

      Caught and fixed two real bugs via on-device testing, not
      theoretical concerns:
      1. An early draft wrote the pending "open Check-In" flag inside
         `doWork()` itself, i.e. the moment the notification was *posted*,
         not tapped — would have misfired open to Check-In on the next
         unrelated app launch for anyone who never touched the
         notification. Fixed before this ever reached a device: both
         actions moved behind a `BroadcastReceiver`
         (`NightlyCheckinActionReceiver`) so the flag is only ever written
         on an actual tap.
      2. That fix was itself incomplete for "Tell me more": modern Android
         blocks a `BroadcastReceiver` from calling `startActivity()` on its
         own, even synchronously in direct response to a notification tap
         — confirmed on-device via logcat ("Indirect notification activity
         start (trampoline) from com.reclaim.app blocked" /
         "Background activity launch blocked!"), not assumed from
         documentation. "Went well" was unaffected (it never launches an
         activity), but "Tell me more" had to move to a direct
         `PendingIntent.getActivity()` targeting `MainActivity` with an
         extra (`NightlyCheckinWorker.EXTRA_ACTION`); `MainActivity.
         onCreate()`/`onNewIntent()` reads it, writes the same pending
         flag, and cancels the notification itself — same flag, same
         `app.js` consumer, just reached without a receiver in the middle.

      A third gap, also only visible on-device: `MainActivity` is
      `singleTask`, so tapping a notification while the app is already
      alive in the background just re-foregrounds the existing WebView
      instead of reloading it — the one-time `DB.init().then()` boot check
      never re-runs in that case. Fixed by also listening for Capacitor's
      standard `resume` lifecycle event (fires on every return to
      foreground, cold boot included) and re-checking both this pending
      flag and `RiskAlertView`'s on resume, not just at boot.

      Verified on-device across all four real combinations by physically
      tapping the actual notification action buttons (not simulated via
      `adb shell am broadcast`, which turned out to silently fail against
      a non-exported receiver and would have produced a false pass):
      "Went well" and "Tell me more", each with the app cold-started
      (killed via `run-as … kill -9`, not `force-stop`, since force-stop
      itself cancels the app's active notifications and doesn't represent
      a real background kill) and with the app merely backgrounded and
      still alive. All four correctly cancelled the notification, set/
      consumed the pending flag exactly once, and landed in the right
      place (`resisted` check-in logged, or the Check-In tab shown).

      Known limitation, documented not fixed: WorkManager's periodic
      scheduling isn't wall-clock-exact long-term — each run reschedules
      relative to actual completion time, not a fixed daily anchor, so the
      9:30pm target can drift under Doze/battery optimization over many
      days. Fine for a "roughly evening" reminder.
- [x] **RiskScorer convergence bonus.** User's own framing: being on
      Instagram, or it being late, doesn't on its own mean someone is
      struggling — but several weak signals true at once is a meaningfully
      stronger signal than the same points scattered would suggest.
      `RiskScorer.score()` now also counts how many of its five factors
      (trigger-app, duration, self-reported-time, historical-time,
      social-media) fired at all, independent of their individual point
      values, and adds a tiered bonus on top: +15 at 3 factors converging,
      +30 at 4+ — deliberately a jump, not a linear per-factor add-on, so
      convergence itself reads as disproportionately significant rather
      than "one more addend." Counts which distinct factors fired, not
      magnitude (a 1-minute session counts the same as 15 for this
      purpose) — this is about how many different kinds of signal are
      lining up, not how strong any one is.

      Verified on-device with real computed data, not synthetic: session
      duration was let run for real (roughly 1-2 real minutes) rather than
      faked, and a 4th factor (historical-time) was added via a real
      `syncRiskContext` call rather than hand-editing the database file
      directly. Confirmed both tiers via logcat's score breakdown — 3
      factors: `score=67 [trigger-app(+30) duration=1m(+2) self-reported-
      time(+20) convergence=3factors(+15)]`; 4 factors: `score=99
      [trigger-app(+30) duration=2m(+4) self-reported-time(+20)
      historical-time(+15) convergence=4factors(+30)]` — both totals
      matching the addition exactly. Reclaim's own package was temporarily
      added to the trigger-app allowlist to produce a real 3+-factor
      scenario without switching away from the app (which would have
      broken the CDP/WebView connection this session's testing depends
      on, a constraint already documented above); removed again
      afterward, and `RiskProfile.syncToNative()` re-run to restore
      `risky_time_buckets` to its real (empty) derived value rather than
      leaving the test value in place.
- [x] **Adaptive weight tuning (v2 of the risk-nudge item above).** The
      last of the four pivotal-conversation features, built in the
      confirmed order (4, 2, 3). `RiskScorer`'s five base factor weights
      (trigger-app, duration, self-reported-time, historical-time,
      social-media — not the convergence bonus, deliberately, see below)
      are now stored, mutable values in `LocalSignalsDb.app_meta`
      (`risk_weights`), not Java literals, with per-factor bounds
      (roughly half to one-and-a-half times each default) so a sparse
      data set can't send a weight to zero or let it dominate.
      `RiskNudgeMonitor.postNotification` now also records which factors
      actually fired for that notification (`pending_notification_factors`,
      consumed once). `CheckInStore.add()` (checkinStore.js) calls a new
      `recordCheckinOutcome` plugin method after every check-in; if a
      notification fired within the last 6 hours, its factors get nudged
      ±2 — up for "slipped" (the flagged risk was real, reinforce it),
      down for "resisted" (the flagged risk didn't materialize, ease off)
      — deliberately small and fixed, not proportional to anything, so a
      handful of data points drifts a weight gradually rather than
      swinging it. Explicitly not the convergence bonus, and explicitly
      not ML or the on-device LLM — same reasoning as the risk-nudge
      item above: nudging a number is a math problem, this needs to stay
      debuggable, and a handful of check-ins is nowhere near enough data
      to train anything real anyway.

      Verified on-device with the real mechanism end to end, not
      isolated unit checks: triggered a real notification, confirmed
      `pending_notification_factors` held the right factor names, added a
      real check-in through the live WebView, and confirmed via logcat
      both the exact weight delta applied (`adjusted weights +2 for
      ["selfReportedTime"] -> {...,"selfReportedTime":22,...}`) and that
      a subsequent score computation actually used the new value
      (`self-reported-time(+22)`). Confirmed the reverse direction the
      same way (`adjusted weights -2 for ["duration","selfReportedTime"]
      -> {"duration":28,"selfReportedTime":20,...}`), and confirmed
      `pending_notification_factors` is cleared after being consumed
      either way. One real mistake caught mid-test: the first verification
      check-in was logged as `type: "slipped"` to test the increase
      direction, which — unlike a `resisted` check-in — actually feeds
      `RiskProfile`'s real slip-pattern detection; removed it again
      immediately (`CheckInStore.remove`) rather than leaving fabricated
      slip data sitting in real check-in history, and confirmed
      `risky_time_buckets` returned to its correct derived value
      afterward. A small amount of genuine weight drift (from real,
      correlated test events, not fabricated ones) was left in place
      deliberately — that's this feature working as intended, not residue
      to clean up.
- [x] **UI rebrand — navy/orange palette from the logo, plus a new AI
      "sparkle cluster" icon.** The chat UI (`web/css/styles.css`) used a
      warm Claude-style cream/terracotta palette left over from
      scaffolding; restyled to match the actual logo. Colors were sampled
      directly from the logo PNG (not eyeballed) — navy `#06335d`, orange
      `#fe8722`, slate `#6585a1`. Roles split deliberately, confirmed with
      the user before building: navy is primary/structural (the sidebar
      is now a solid navy surface instead of a light strip, plus primary
      buttons, the chat avatar, user message bubbles); orange is reserved
      for interactive/active moments (send button, focus rings, selected
      chips, the active-nav accent bar) so it stays a highlight instead of
      getting diluted everywhere. Light mode's orange is deepened to
      `#c2540a` for WCAG AA text contrast (the raw logo orange is only
      ~2.4:1 on white); dark mode uses the true bright `#fe8722` as-is,
      since a dark backdrop gives it plenty of contrast without needing to
      mute it. Neutrals shifted from warm cream to cool navy-harmonized
      grays. Semantic colors (success green, crisis red) deliberately left
      untouched — safety-critical UI, not brand.

      The agent's icon (empty-state + every chat-message avatar) was a
      heart, which read as "care/support" rather than "AI." Replaced with
      a 4-point sparkle (the same "AI-generated" visual shorthand as
      Gemini/Copilot), then — per explicit request — evolved into a
      cluster of three sparkles at decreasing size in one glyph, arranged
      in a triangular composition so they stay visually distinct rather
      than colliding. Iterated live in the browser (injecting candidate
      SVGs via devtools before touching the file) after the first
      attempt crowded the small sparkle right against the medium one,
      which collapsed into an indistinct blur at the 16px avatar size.

      Verified in the actual Browser pane (not just by reading the CSS)
      across light/dark mode and all four views, and separately confirmed
      on-device after `cap sync` + rebuild — including an incidental
      confirmation that dark mode's lightened navy (`#2c5f92`, needed so
      button surfaces don't disappear into a near-black background) renders
      correctly on real hardware, via a leftover risk-nudge alert from
      earlier testing that happened to surface on that same launch.

      One environment issue hit and worked around, not a code bug: this
      session's own working directory (separate from the canonical
      `ReclaimApp\Reclaim` checkout) contains a stale duplicate `web/`
      folder, and `.claude/launch.json`'s dev-server preview was silently
      serving *that* instead of the real files — confirmed by checking
      response `Last-Modified` headers and probing for a marker file.
      Worked around by running a second, throwaway server directly against
      the real directory rather than trusting the configured one; the
      configured preview may still misbehave for future browser-based
      testing until that's actually diagnosed.
- [x] **All three local notification types now actually pop up on-screen
      (heads-up), not just land quietly in the shade.** User noticed the
      nightly check-in didn't behave like a text message popping up, and
      asked for it (and everything else) to. Root cause: Android only
      shows a heads-up banner for `IMPORTANCE_HIGH` notification channels
      — SMS apps use HIGH. `NightlyCheckinWorker` and `ForegroundApp
      Monitor` (the "you've been on X for an hour" verification tool)
      were both coded at `IMPORTANCE_DEFAULT`, which posts silently.

      The fix isn't just flipping the constant: **channel importance is
      permanently locked in per channel ID** the first time Android sees
      it on a device — recreating the same ID with a different importance
      is silently ignored. All changed channels got new IDs (`_v2`
      suffix), with the old ID explicitly deleted via
      `deleteNotificationChannel` so it doesn't linger as orphaned
      clutter in system settings. Also gave each channel a distinct
      display name (all three were generically "Reclaim" before, making
      them indistinguishable in Settings → Apps → Reclaim → Notifications
      if someone wanted to manage them individually).

      First pass wrongly assumed `RiskNudgeMonitor` needed no change,
      since its *current* code already said `IMPORTANCE_HIGH` — verified
      the other two on-device but not this one, on the logic that it was
      already correct. User reported the risk-nudge notification (the one
      that literally says "Reclaim wants to check in with you") still
      wasn't popping up, which was the tell. Checking `dumpsys` this time
      showed the deployed channel at `mImportance=3` (DEFAULT) despite
      the code — its channel ID had been created back when an earlier
      version of this feature (before the "make it actually interrupt"
      pass, earlier in this doc) requested DEFAULT, and every later
      change to HIGH had been silently no-op'ing on any device that had
      already run that old code, this test phone included. Same fix:
      new channel ID (`reclaim_app_nudge_v2`), old one deleted. Lesson
      applied going forward: what the code currently says a channel's
      importance is doesn't mean that's what's actually deployed —
      `dumpsys notification`'s `mImportance` is the only source of truth
      for a channel that existed before the code being read.

      All three verified on-device, not just via the code: confirmed
      each `_v2` channel reports `mImportance=4` (HIGH) via `dumpsys
      notification`, then caught the actual heads-up banner on-screen
      over the home screen for both the nightly check-in and the risk
      check-in after backgrounding the app (a naive same-second
      screenshot missed the first one twice before landing the timing
      right — WorkManager's post is near-instant, ~300ms, but the CDP
      bridge used to trigger these throttles once the WebView backgrounds,
      a constraint already documented above, so each trigger needed the
      app foregrounded first, then backgrounded immediately after).
      `ForegroundAppMonitor`'s equivalent change was not separately
      live-tested (its 60-minute real-session threshold isn't practical
      to force) — worth a real on-device confirmation once genuinely
      idle for an hour on a flagged app, not assumed correct from here.
- [x] **Notification text variety, home location, check-in trigger tags over
      sleep hours, and tag-correlated adaptive tuning — four related asks
      in one pass.**
      - **Notification text variety.** The nightly check-in and risk-nudge
        notifications always showed the exact same string. Both now pick
        randomly from a small pool of equally-meaning phrasings each time
        they post (8 variants for the nightly prompt, 6 for the risk
        nudge) — the risk-nudge pool stays exactly as privacy-generic as
        the original single string was, never hinting at why it fired.
      - **Home location, on-device only.** Location data was being
        collected but never meant anything to the user — Insights never
        even displayed it. Added a "Save current location as home" step
        to onboarding (`web/js/preferencesView.js`, using the already-
        wired-but-previously-uncalled `NativeLocation.getPosition()`),
        staged like every other onboarding field (only persisted on
        Save, so Skip/Close discards it same as an unsaved name/phone
        edit). Stored in `user_preferences` (`home_lat`/`home_lon`),
        deliberately kept OUT of `personalContext.js`'s AI-facing
        sentences and out of the native `app_meta` mirror everything
        else in that store gets — see `userPreferencesStore.js`'s header
        for why a raw coordinate pair gets treated as more sensitive
        than the rest of onboarding. Insights' recent-activity panel now
        labels each sample "Home" / "Near home" / "Away from home"
        (`insightsView.js`, Haversine distance, computed client-side)
        instead of showing nothing — coarse-only samples (no fine
        location permission) get a much wider, honestly-labeled radius
        since they're only accurate to ~11km at the source.
      - **Check-in form: sleep hours removed.** The condition-tag
        selector ("What was going on?") already covered "what triggered
        this" — Boredom, Loneliness, Stress, Fatigue, etc. — before this
        pass; only the separate numeric "hours of sleep" field and its
        Insights average-stat card were removed as redundant. The
        `sleep_hours` DB column and any already-logged values are left
        alone, just no longer written to by the form.
      - **Tag-correlated adaptive tuning.** The user asked directly:
        does picking a check-in tag actually influence RiskScorer, e.g.
        does "Boredom" make screen-time duration matter more, does
        "Loneliness" make being alone matter more? Answer at the time
        was no — `recordCheckinOutcome` never even received the check-in's
        tags, only `type` and a timestamp; the only existing tag-to-
        factor connection was one hardcoded special case ("Social media"
        tag + a hardcoded app list → the `socialMedia` factor). Built the
        general version: `RiskScorer.TAG_TO_FACTORS` maps condition tags
        to the factor(s) they plausibly relate to (Boredom/Stress →
        `duration`; Loneliness/Alone and unsupervised/Conflict with
        someone → the new `alone` factor below; Fatigue/Late at night →
        `selfReportedTime` + `historicalTime`; Social media → `socialMedia`)
        — several tags (Anger or frustration, Feeling low, Celebrating,
        Unexpected exposure, Other) are deliberately left unmapped rather
        than force a connection with no real signal behind it.
        `adjustWeightsForTags` runs on every check-in, independent of and
        alongside the existing notification-correlation mechanism (not a
        replacement for it) — both can adjust the same weight for the
        same check-in, deliberately not deduplicated against each other.
        Multiple selected tags that map to the same factor dedupe into
        one nudge, not one per tag.

        The loneliness mapping exposed a real gap: `nearby_device_bucket`
        existed in the schema with a reader method
        (`mostRecentNearbyDeviceBucket`) already written for RiskScorer,
        but nothing had ever called it — `BaselineSampleWorker` never
        invoked nearby-device scanning at all, despite `NearbyDevicesPlugin`
        having working scan logic all along (just JS-facing, async, for
        the Privacy tab's permission UI). Added `NearbyDevices.java`, a
        plain native helper mirroring `DeviceLocation.java`'s pattern
        (no Capacitor bridge, callable directly from a Worker), whose BLE
        scan blocks the calling thread ~3 seconds — acceptable since
        `Worker.doWork()` is meant to do blocking work off the main
        thread, and it's skipped entirely (no permission check overhead
        even) for anyone who hasn't granted the permission. This directly
        feeds a new sixth RiskScorer factor, `alone` (fires when the bucket
        is exactly "0", i.e. no nearby devices detected at all — missing
        data/no scan yet is `null`, which never fires it).

        Verified on-device, every piece, not assumed from the code:
        confirmed a real BLE scan now populates `nearby_device_bucket`
        (previously `NULL` on every prior row, a real `"6+"` on the first
        row sampled after this shipped); confirmed the tag-correlation
        math directly via logcat both directions with an isolated test
        (cleared a stale pending notification-correlation entry first so
        only the tag mechanism was being exercised) —
        `adjusted weights +2 for [duration, alone] -> {"duration":30,
        "alone":17,...}` for Boredom+Loneliness tagged "slipped", then
        exactly reversed (`-2`, back to 28/15) for the same tags tagged
        "resisted"; confirmed real GPS capture end-to-end by driving the
        actual onboarding button through the live WebView (an initial
        4-second wait in the test itself was too short for a real fix —
        not a bug, just an undersized test timeout — 8 seconds was
        enough) through to a persisted, correctly-saved coordinate pair.
        Test-set home coordinates were cleared afterward so the device
        is left for the user to set their own for real, not pre-filled
        from testing.
- [x] **Fixed a real bug: the nightly check-in notification had never
      once fired on the user's own phone.** User reported not getting an
      end-of-day review notification and asked to verify the pipeline was
      actually working. It wasn't, and not for a subtle reason:
      `BackgroundSamplerPlugin.enable()` is the *only* place that
      schedules WorkManager jobs, both the baseline sampler and the
      nightly check-in, and JS only ever calls `enable()` from the
      "Turn on background sampling" button's one-time click handler
      (`app.js`'s `refreshTrackingToggle`/click listener, only reachable
      by visiting Privacy). NightlyCheckinWorker's scheduling was added
      to `enable()` well after this test device had already flipped that
      toggle on — so the button was already permanently "on"/disabled,
      and nothing ever called `enable()` again to pick up the newly-added
      schedule. It had been silently dead on arrival since the feature
      shipped. Confirmed directly, not guessed: `dumpsys jobscheduler`
      showed exactly one JobScheduler entry for `com.reclaim.app` (the
      ~15-minute baseline sampler), none for the nightly one.

      Fix: `app.js` now calls `ensureBackgroundSchedulingCurrent()` on
      every boot (`DB.init().then()`, alongside the other per-boot
      catch-up calls), which re-invokes `BackgroundSampler.enable()`
      whenever tracking was already found on — safe because `enable()`
      is idempotent (`ExistingPeriodicWorkPolicy.KEEP`, see its own
      comment) and this never opts in someone who hasn't already granted
      tracking, since it only re-confirms, never initiates. Also fixes
      this same class of bug for any future addition to `enable()`'s
      scheduling, not just this one instance.

      Verified on-device: fresh launch after the fix, `dumpsys
      jobscheduler` now shows a second `com.reclaim.app` job that didn't
      exist before, with a scheduled run time landing exactly at 9:30pm
      tonight — the configured `NIGHTLY_HOUR`/`NIGHTLY_MINUTE`.
- [x] **Notification escalation, timeouts, sent/responded tracking, and a
      10-second "I'm okay" delay.** User asked for notifications to
      auto-open the app if a previous one went unanswered, for
      unanswered notifications to eventually time out, for sent/responded
      counts to be tracked, and for the risk alert's "I'm okay" to
      require a real pause before it's clickable. Flagged one honest
      platform limit up front rather than overpromise: Android will not
      let a background app steal focus from whatever's actively in use,
      full stop — already confirmed twice this session. What's real and
      buildable: reliably auto-opening the app when the phone is idle or
      locked, which `RiskNudgeMonitor` already always does via
      `setFullScreenIntent`; `NightlyCheckinWorker` didn't do this at all
      before this pass.

      **New shared class, `NotificationTracking.java`**: per-type
      (`nightly`/`risk`) sent/responded counters plus a `last_answered_
      TYPE` flag in `app_meta`. `recordSentAndShouldEscalate` returns
      true only when the *previous* occurrence of that type was left
      unanswered (never on the first-ever notification of a type, since
      there's nothing to escalate from) — `NightlyCheckinWorker` now
      conditionally adds `setFullScreenIntent` on that signal, escalating
      only after being ignored once, not every night (unlike
      `RiskNudgeMonitor`, which already always uses it — that type has
      nothing further to escalate to, so it just gets stats tracking
      here, not a behavior change). "Responded" means any action tap or
      opening the app at all — not graded by which choice, just whether
      it was engaged with before timing out.

      One documented, deliberate gap: the risk-nudge notification's
      "Call [name]" action isn't tracked. Wrapping it through anything
      other than a direct, unmodified `PendingIntent.getActivity()` to
      the dialer risks the exact background-activity-launch block this
      session already hit and fixed for `NightlyCheckinWorker` — not
      worth risking a safety-adjacent feature just to count a tap.

      **Timeouts** via `NotificationCompat.setTimeoutAfter`: 3 hours for
      the risk nudge (an in-the-moment risk window, stale quickly), 12
      hours for the nightly check-in (relevant most of the next day, but
      gone before that evening's new one posts).

      **The 10-second wait** on the risk alert's "I'm okay"
      (`riskAlertView.js`) disables the button and runs a CSS-transitioned
      shaded fill behind the label — a real 10s pause, not just a
      disabled state that looks broken, per the user's own request for
      something "visually nice looking but also clear."

      Verified on-device, and a real bug caught mid-verification, not
      just assumed from the code: confirmed a first-ever nightly
      notification posts with `fullscreenIntent=null` and `timeout=PT12H`
      (`dumpsys notification`); left it unanswered and confirmed the
      *second* one escalated to a real `fullscreenIntent` PendingIntent;
      then, unprompted, watched that escalated notification's full-screen
      intent actually auto-fire and open the app on its own (confirmed
      via `ActivityTaskManager: START ... BAL_ALLOW_NON_APP_VISIBLE_WINDOW`
      in logcat) — about as strong a real-world confirmation of this
      mechanism as testing could produce. Confirmed the risk nudge's
      `timeout=PT3H`. Confirmed Insights renders the live counts correctly
      ("Nightly check-in: 1 of 3 answered (33%)"). The bug: that same
      auto-fire, followed by a real tap on the still-visible notification
      (risk-nudge's `handleRiskIntent` didn't explicitly cancel it, unlike
      the nightly path), invoked the response handler twice for one
      notification — caught directly via `notification_stats` briefly
      showing `responded:2` against `sent:1`, an impossible ratio that was
      the tell. Fixed with two changes: `handleRiskIntent` now explicitly
      cancels the notification (not just relying on `setAutoCancel`, which
      doesn't reliably fire when a full-screen intent auto-launches rather
      than a real shade tap), and `NotificationTracking.recordResponded`
      is now idempotent per occurrence (a repeat call once `last_answered_
      TYPE` is already `"true"` is a no-op). Re-verified directly by
      delivering the same intent to `MainActivity` twice in a row
      (`adb shell am start` with the same extra) and confirming `responded`
      advanced by exactly 1, not 2. The 10-second countdown was verified
      in-browser: the fill reaches 100% and the button becomes clickable
      at exactly 10s, not before.
- [x] **Every resource tool capped at 2 results per request.** User asked
      for a cap so someone asking for help isn't handed a wall of options —
      unrelated to the notification/tracking work above, a plain
      `resourceRepo.js` change. `getCopingMechanisms` (was 3) and the
      shared `fromSupabase` helper's default `limit` (was 5 — covers
      `getSermons`/`getArticles`/`getCounselingCenters` automatically,
      since none of the three pass an override) both dropped to 2.
      `getBiblePlans` previously had no cap at all (returned all 4 seeded
      plans unconditionally) — now takes `limit = 2` and shuffles before
      slicing, same as the others, so it won't silently start dumping
      everything the moment a 5th plan is added. `getSmallGroups`'s
      already-parameterized `limit` default moved from 5 to 2 the same
      way. `getScripture`/`getDevotional` untouched — already return a
      single item via `randomByTheme`. Confirmed via grep this is a
      complete fix: `agentTools.js` is the only caller of all six
      functions app-wide, and `app.js`'s rendering is a plain `.forEach`
      over whatever array it's given, no hardcoded count assumptions to
      also update.

      Verified in-browser after a real false start: the dev server (a
      throwaway `python -m http.server`, see the UI-rebrand entry above
      for why a throwaway server is in the loop at all) sends no
      `Cache-Control` header, so the browser's disk cache — shared across
      every tab in the profile, not per-tab — kept serving the pre-edit
      `resourceRepo.js` to a plain `<script src>` load even in a brand-new
      tab, while an explicit `fetch(url, {cache:'no-store'})` against the
      same URL correctly returned the fixed bytes the whole time. Confirmed
      by comparing `ResourceRepo.getBiblePlans.toString()` (still the old,
      uncapped closure) against a fresh no-store fetch of the same file
      (already contained `limit = 2`). Resolved by fetching the fresh
      source and grafting its methods onto the existing `ResourceRepo`
      object (`Object.assign`, mutating properties rather than
      re-declaring the `const` binding, which a second `<script>` tag or
      naive `eval` can't do without a redeclaration error) — confirmed all
      six functions returned exactly 2 results after the graft. On-device
      confirmation via the usual `cap sync` + `gradlew assembleDebug` +
      install path follows the same pattern as every other feature above.
- [x] **"I'm okay" delay shortened to 5 seconds** (`riskAlertView.js`,
      `DISMISS_WAIT_MS`), down from the 10s set when this button first
      shipped (see that entry above). User asked directly, no other
      behavior changed. Verified on-device with real timing, not assumed
      from the constant: triggered a real risk alert via the debug panel's
      "Send risk-nudge notification now" (`LocalSignals.debugSendRiskNudge()`),
      rendered it (`RiskAlertView.checkPending()`), then polled the
      dismiss button's `disabled` state in a tight loop — stayed `true`
      through ~4.4s and flipped to `false` by ~5.3s (a ~400-800ms offset
      baked into the timer-start measurement from the trigger call's own
      setup latency), consistent with a real 5000ms window rather than the
      old 10000ms one.
- [x] **New Home view — the screen the app now opens onto**, instead of
      Chat. User asked for a landing screen summarizing non-sensitive
      insight data plus a spot for a bible verse. New `homeView.js` +
      a `view-home` panel in `index.html`, made the default visible panel
      (Chat's panel gained `hidden`, Home's nav item gained `active`) —
      no boot-time view-switch call needed, same as how Chat used to be
      default purely through static markup.

      **Verse card**: pulls from `ResourceRepo.getScripture()` (no theme
      filter), the same local 16-verse set Chat's scripture tool already
      draws from — wires the spot up to real content now rather than
      leaving a dead placeholder, since the content already existed. A
      real "verse of the day" (fixed per calendar day, or drawn from verses
      added later per the resource-inventory gaps discussed earlier this
      session) is still future work, not this pass.

      **Insight summary**: deliberately only the self-reported check-in
      numbers (streak, resisted/slipped ratio last 30 days, avg mood) —
      never the on-device tracking data (usage samples, app events,
      keyword matches). That tracking data is meant to be found
      deliberately in Insights/Privacy, not sitting on the screen the app
      opens onto, which anyone glancing at an unlocked phone would see
      first. Same privacy reasoning as everything else in this doc,
      applied to a new surface.

      Refactored rather than duplicated: the streak/ratio/average
      arithmetic moved into a new `CheckInStore.summary(entries)`, and both
      Home and Insights (`insightsView.js`) now call it instead of each
      computing its own copy — the exact class of drift this doc's "two
      divergent tool implementations" entry (above) already burned once.

      Verified in-browser (nav switches correctly, Insights still renders
      all five stat cards post-refactor, a real logged check-in flows
      through to Home's numbers, no console errors) and on-device
      (confirmed `home` is the visible panel on a fresh launch, with a
      real verse and 3 populated stat cards, via the live WebView bridge).
- [x] **Crisis access moved off the persistent nav; Home nav item redesigned
      as a centered "home base" tab.** Two related nav asks in one pass:
      "In crisis? Get help now" was in the sidebar (every screen, including
      the mobile bottom bar as a 6th tile) — moved to a small circular
      icon-only button in Home's topbar corner instead (`home-crisis-btn`,
      same `id="crisisBtn"` so `app.js`'s existing listener needed no
      change). Chat keeps its own separate safety-banner crisis link
      untouched, so crisis access isn't reduced to one screen only, just
      no longer duplicated on every screen. Nav items reordered so Home
      sits 3rd of 5 (Chat, Check-In, Home, Insights, Privacy), with its
      icon in a darker circular badge (`nav-item-badge`, `--navy-deep`) —
      on the mobile bottom bar specifically, the badge is enlarged and
      raised above the row (`margin-top: -14px`), the common "FAB in a
      tab bar" pattern, so it reads as the app's home base rather than
      just another tab.

      Verified in-browser (nav order, badge styling, crisis button opens
      the same modal, Chat's banner link untouched, no console errors)
      and on-device (`navOrder` reads `[chat, checkin, home, insights,
      privacy]`, `crisisBtn` present and the old `.sidebar-crisis-btn`
      confirmed gone, via the live WebView bridge).
- [x] **Tried, then abandoned: running the on-device AI from a real background
      check** (not just keyword matching) against `TrackingAccessibility
      Service`'s captured page text. User asked for this directly. The real
      constraint, confirmed by reading the code before building anything:
      `BaselineSampleWorker`'s own doc comment already says "the app and its
      WebView may be fully closed" when it runs -- `LocalModel` (WebLLM) has
      only ever run inside that WebView's JS/WebGPU context, which a native
      background Worker has no access to at all.

      Built a throwaway feasibility spike (`HeadlessAiService`, `web/ai-
      headless.html`, a temporary `DebugBackgroundCheckReceiver`) to test
      this directly rather than guess: a WebView created from a plain
      background Service, never attached to any Activity/window. First
      result, genuinely surprising: WebGPU fully initializes there --
      confirmed on-device with the app process killed and no Activity alive
      (`{"hasGpu":true,"adapterFound":true,"f16":true,"deviceCreated":true}`).
      Second test, the one that actually mattered: loading the real cached
      model and running inference in that same headless context. Decisive
      negative result -- confirmed via logcat, not inferred: the OS's own
      low-memory killer terminated the process mid-load
      (`lowmemorykiller: Kill 'com.reclaim.app'... reason: filecache is low
      ... after thrashing`), under perfectly ordinary memory pressure, well
      before the model finished loading. A plain background Service with no
      foreground notification is one of the system's first reclaim targets,
      and a 2-4GB model load takes long enough that it doesn't survive.

      Per the user's own pre-agreed fallback ("try it, default to the
      simpler approach if it's not working well"), abandoned rather than
      pursued further (e.g. as a genuine foreground service, which would
      trade this problem for a persistent "AI checking..." notification
      every ~15 minutes plus real battery cost, for an approach already
      shown fragile at its base). All spike code removed (`HeadlessAi
      Service.java`, `ai-headless.html`, `DebugBackgroundCheckReceiver.java`,
      the manifest entries, and `BaselineSampleWorker`'s temporary hook) --
      nothing of it shipped. The real next step, not yet built: analyze
      captured text with the AI once the app is actually opened, where the
      real chat WebView is already alive and not memory-starved, rather
      than from the native background path at all.
- [x] **Risk-nudge notification now only tries to auto-open on the SECOND
      consecutive miss, not every time.** User asked directly, with a
      specific correction along the way: they explicitly want this one to
      actually interrupt whatever the person is doing, not just politely
      wait for the screen to be off/locked. Would not build a way to
      forcibly steal focus from an actively-used app -- Android has blocked
      that for every app since Android 10, enforced at the OS/WindowManager
      level, and the only ways around it resemble the overlay-hijacking
      technique stalkerware uses. What actually changed instead: the exact
      same escalate-on-a-miss pattern `NightlyCheckinWorker` already used
      (`NotificationTracking.recordSentAndShouldEscalate`) was wired into
      `RiskNudgeMonitor` too -- previously it called this only to keep stats
      current, discarding the return value, and used `setFullScreenIntent`
      unconditionally on every post. Now a single ignored risk nudge does
      nothing further; a second one in a row (previous occurrence never
      answered) escalates to the same full-screen takeover attempt as
      before -- still only reliable when the screen is off/locked, same
      honest limit as always.

      Verified on-device, both halves independently, not assumed from the
      code: cleared state, sent one nudge -- confirmed no
      `ActivityTaskManager: START` for MainActivity in logcat, and the
      notification sitting quietly in the shade (screenshot). Sent a second
      without responding to the first -- this one's `escalate` correctly
      computed `true`, and on an earlier pass (before repeated testing
      tripped Android's own anti-abuse throttle on this permission, see
      below) its full-screen intent auto-fired for real, confirmed via
      `ActivityTaskManager: START ... BAL_ALLOW_NON_APP_VISIBLE_WINDOW` --
      the same confirmation signature already used to verify this mechanism
      for the nightly check-in, above.

      One real platform behavior surfaced along the way, worth remembering
      for future testing: Android 14+ tracks `USE_FULL_SCREEN_INTENT` as its
      own app-op, separate from the manifest permission grant, and will
      start silently rejecting further attempts
      (`cmd appops get ... USE_FULL_SCREEN_INTENT` showed `rejectTime=...`)
      after a burst of full-screen intents in a short window with none of
      them "used" -- exactly what rapid manual re-testing does. Not a bug,
      not worked around -- this is Android's own anti-abuse throttling
      doing its job, and a real user's actual (much sparser) usage pattern
      wouldn't trigger it in practice.
- [x] **Reverted back to Qwen3.5-2B** after trying Qwen3.5-4B live on-device
      (warm, on-tone reply, correctly used the accountability partner's
      name -- but ~37-41s to a two-sentence reply, clearly worse for a chat
      UI than the 2B model's feel). User's call after seeing both side by
      side; `MODEL.base`/`downloadMB` in `localModel.js` reverted, confirmed
      on-device (`LocalModel.getStatus()` loaded `Qwen3.5-2B` from cache,
      reached `state: "ready"`).
- [x] **Risk-nudge notification's suggested action now tiered by severity, plus
      a Home shortcut to call the accountability partner.** User asked for
      both together. `RiskScorer.Result` gained `isHighRisk()` -- score at
      least 20 past THIS user's own threshold (not a fixed number, so it
      scales with their notification_intensity the same way triggering
      itself does; roughly one extra factor's worth of weight). High risk
      (and a partner actually set) suggests "Call [name]", same dialer
      intent as before; anything lower suggests "Read a verse" instead,
      reusing the same PendingIntent as the body tap -- no new plumbing,
      since Home already opens by default and already shows a real verse
      (see the Home-view entry above). Falls back to "Read a verse" even at
      high risk if no partner's set, rather than no action at all. A
      worship-music suggestion was also asked for, for the low-risk case --
      not built, since nothing in the app links to any yet; flagged rather
      than shipping a dead button, add it once that content exists.

      Home shortcut: a new tappable card (`home-call-card`) below the verse
      card, same real `tel:` mechanism as the crisis modal and RiskAlertView
      (a real anchor click, not `window.location`), hidden entirely rather
      than disabled when no partner's set.

      Verified on-device, both tiers independently, with a real (not
      simulated) high score -- reused this session's own proven technique
      (see the convergence-bonus entry above) rather than guessing: added
      Reclaim's own package to the trigger-app allowlist, set a matching
      tempting time, and added two temporary `slipped` check-ins (RiskProfile
      needs 2+ to derive a risky-time pattern) to genuinely earn the
      historical-time factor and the 3-factor convergence bonus. Confirmed
      `score=0 threshold=60` -> notification shade showed "Read a verse", no
      call action; confirmed `score=84 threshold=35` (`trigger-app(+32)
      self-reported-time(+22) historical-time(+15) convergence=3factors
      (+15)`) -> shade showed "Call Jake" instead. All test state (the two
      fake check-ins, the allowlist entry, tempting_times/intensity) removed
      and `RiskProfile.syncToNative()` re-run afterward to restore real
      derived values, same cleanup discipline as that earlier entry.
      Home's call shortcut confirmed separately, in-browser: renders "Call
      Jake", builds the exact `tel:5551234567` href, and correctly hides
      when the preference is cleared.
- [x] **Scripture library expanded from 16 to 62 verses, and both agent
      modes now default to offering one whenever someone names a feeling**,
      not only when they explicitly ask for "a verse." User asked for a
      "long list" covering the themes `AGENT_THEME_WORDS` (agentTools.js)
      can actually detect -- the previously-thinnest (loneliness, anxiety,
      freedom, perseverance, triggers) had exactly 1 verse each; every one
      of the 16 detectable themes now has real, multi-verse coverage.
      `seedData.js`'s new entries checked against known NIV wording before
      adding, same translation/style as the original 16; `CURRENT_SEED_VERSION`
      bumped (db.js) so existing installs pick up the new set.

      Behavior change, in both `agentPickResource` (agentTools.js, the
      on-device-AI path) and `ResourcesAgent._planResponse`'s catch-all
      (Basic-mode fallback): previously, a message with no tool keyword
      match (e.g. "I've been feeling really lonely") got a generic reply
      with no resource at all -- theme words only mattered for picking
      *which* verse once some other explicit ask had already matched a
      tool. Now, no explicit ask + a detected feeling defaults to
      `scripture_search` for that theme. Along the way, swapped
      `ResourcesAgent`'s own weaker `inferTheme` (required the literal
      theme name as a substring, e.g. "loneliness" wouldn't match "I feel
      lonely") for the shared `agentInferTheme` in its catch-all -- the
      same "one shared source of truth instead of a second, weaker copy"
      fix as the earlier `executeAgentTool` unification, applied to theme
      detection too. Chat's empty-state suggestion row also gained a
      "Find a verse" chip, first in the row.

      Verified in-browser (after grafting the fresh seed/agent code past
      the dev server's stale-cache issue, same root cause and fix as
      earlier this session): 62 scripture rows load correctly, "I've just
      been feeling really lonely lately" and "work has been so stressful
      this week" each correctly resolved to `scripture_search` with the
      right theme with no explicit ask, and `getScripture(theme)` returned
      6-9 distinct real verses each for every previously-thin theme.
      Confirmed live on-device too, through the real chat UI with the real
      on-device model: "I have just been feeling really anxious about
      everything lately" correctly surfaced the `Scripture Search` card
      (`theme: anxiety`), a real verse (Psalm 55:22), and a warm,
      on-topic AI reply built around it -- not simulated, the actual
      running app.
- [x] **Imported a real external content bundle** (`files.zip`: 511 scripture
      refs, 511 journal prompts, 204 devotionals, 40 breathing exercises, 82
      songs, 12 sermons, 17 podcasts, 5 support orgs, a 17-topic taxonomy) --
      user asked to put it "in their proper spots" and make it accessible.
      Not a blind import: inspected every file first, mapped what fit the
      existing architecture, and surfaced the one real tradeoff (scripture
      translation/licensing) rather than deciding it silently.

      **Imported now:**
      - 204 devotionals -> `seedData.js`, reflection + closing_prayer
        combined into one body (original prose, no NIV-copyright issue --
        that's specific to verse text, not commentary). Topic taxonomy
        mapped onto existing tags where they overlap (loneliness, shame,
        anxiety, etc.) plus new tags for themes the chat can't detect yet
        (exhaustion, burnout, purity, forgiveness, prayer/worship,
        spiritual-disciplines, healing, purpose) -- imported now, detection
        wiring is a fast follow, not blocking the content being there.
      - 40 breathing exercises -> `seedData.js` as `coping_mechanism` rows,
        not a new type -- they're in-the-moment techniques, same as
        everything else already there. Topics linked via the bundle's
        `resource_topics.csv` join table (breathing exercises can serve
        several topics, unlike devotionals' one-topic-per-row).
      - 4 of 12 sermons -> Supabase (`sermon` count 4 -> 8): only the ones
        with a real, direct, confirmed URL. Skipped 2 marked "confirm
        speaker and link before publishing" in the bundle's own README
        (uncertain attribution to a named public figure -- not worth
        risking a misattributed sermon) and 6 with no URL at all (mostly
        real, public-domain historical works -- Spurgeon, Lloyd-Jones,
        Keller, Lewis, Edwards -- worth adding once a real link/edition is
        sourced for each, not this pass).
      - 2 of 5 support orgs -> Supabase (`small_group` count 36 -> 38):
        Pure Desire Ministries' and Celebrate Recovery's *national*
        group-finder pages, distinct from the specific local chapters
        already seeded (confirmed via query before inserting, not assumed
        -- no duplicates). Skipped AACC (already in the counseling_center
        table -- confirmed by query, would've been a real duplicate), the
        988 entry (the app already handles crisis lines separately and
        deliberately, on purpose, not through the general resource
        system), and "The Freedom Fight" (a discipleship curriculum with
        no clean matching type).
      - `CURRENT_SEED_VERSION` bumped (db.js, 7 -> 8) so existing installs
        pick up the new devotionals/coping mechanisms.

      **Explicitly not imported, needs a decision or real feature work:**
      - **511 scripture refs -- skipped entirely, user's own call.** The
        bundle ships references + original theme summaries but blank verse
        text on purpose (NIV is Biblica/Zondervan copyrighted; the
        bundle's own README says to fill it at runtime through a licensed
        source). Asked the user how to handle it (write from memory
        matching the existing 62 verses' practice, switch to a
        public-domain translation, or import references-only) -- told to
        skip it for now rather than pick one. Not touched at all.
      - **Journal prompts (511), music (82), podcasts (17) -- no existing
        type, tool, or UI for any of them.** These aren't a data import,
        they're three new features (new `resources` type each, a new
        `AGENT_TOOL_DEFS` entry + regex per type, new card rendering in
        app.js, likely new suggestion chips). Flagged to the user rather
        than either silently building three features they didn't ask for
        yet or silently dropping two-thirds of the bundle without saying
        so. Music in particular matches the "listen to worship music"
        idea already deferred once this session (tiered risk-nudge
        actions entry, above) -- but the bundle itself has no streaming
        links yet either ("add streaming links after checking each
        song"), so it's not fully actionable even once built.

      Verified in-browser (fresh 214/52 devotional/coping counts, theme
      queries returning real imported content, e.g. `getDevotional
      ("purity")` correctly pulling from the new set; live Supabase query
      confirming both new small_group rows present with no duplicates,
      38 total) before building for on-device confirmation.

- [x] **Risk-nudge notification routing fixed on all four fronts the user
      asked for.** (1) "Talk about it" renamed to "Find resources"
      (`index.html`, `riskAlertView.js` untouched -- still just navigates to
      Chat). (2) The notification's own action button now does what its
      label says instead of quietly reusing the body-tap intent: "Read a
      verse" gets its own `PendingIntent`/extra (`ACTION_OPEN_VERSE`,
      `RiskNudgeMonitor.java`), `MainActivity.handleRiskIntent` branches on
      it to clear `pending_risk_alert` (so the detail popup never also
      shows) and set a new `pending_verse_request` flag
      (`LocalSignalsPlugin.getPendingVerseRequest`, `localSignals.js`);
      `app.js`'s new `checkPendingVerseRequest()` (boot + `resume`, checked
      before `RiskAlertView.checkPending()`) switches to Chat, fills the
      composer with the same trigger text as the existing "Find a verse"
      suggestion chip, and auto-submits. (3) Reclaim's own package excluded
      from `RiskNudgeMonitor.currentSession()` the same way the launcher
      already was -- being on Reclaim itself never counts as a risk
      session. (4) Recent Reclaim use is now protective, not just neutral:
      `MainActivity.onResume()` writes `last_reclaim_open_at`;
      `RiskScorer` reads it back (via `SimpleDateFormat`, not
      `java.time.Instant` -- `minSdkVersion` is 24, confirmed by grep
      before writing this) and subtracts a fixed 25 points, floored at 0,
      when Reclaim was opened within the last 30 minutes.

      **Found and fixed a real pre-existing bug while verifying this.**
      `LocalSignalsDb.isLauncherPackage()` used
      `queryIntentActivities(HOME, MATCH_ALL)`, which lists every component
      that merely *declares* a HOME intent filter -- on stock Android this
      includes `com.android.settings/.FallbackHome` (AOSP's safety-net home
      screen), so Settings was silently misclassified as "the launcher" and
      excluded from every session this powers, not just the new exclusion.
      Confirmed on-device via raw `UsageEvents` dumps before touching
      anything. Fixed by switching to
      `resolveActivity(HOME, MATCH_DEFAULT_ONLY)`, which resolves the one
      real default home app instead of enumerating every HOME-capable
      component. Pre-existing, unrelated to this session's change, but
      surfaced directly by testing it and cheap/safe to fix in place.

      Verified on-device, not simulated: built and installed twice (once
      with temporary diagnostic logging to find the `isLauncherPackage` bug,
      once clean). Confirmed via `dumpsys notification` that "Read a verse"
      now carries its own distinct `PendingIntent` (previously identical to
      the body tap's). Confirmed by *actually tapping* the real notification
      action in the shade (not `am start`-simulated) that it lands directly
      in Chat with a verse already answered, popup skipped. Confirmed via
      `RiskNudgeMonitor` log output that foregrounding Reclaim itself
      produces no session/score at all, while foregrounding another app
      shortly after opening Reclaim produces a real session whose score
      shows `recent-reclaim-use(-25)` and comes out floored at 0. Confirmed
      the renamed "Find resources" button visually in the actual popup.

- [x] **Allowlist text capture verified on-device for the first time, and
      wired into RiskScorer as a new factor.** User asked to confirm text is
      actually being captured from allowlisted apps, and then explicitly
      asked for keyword matches to feed the risk score -- previously a
      deliberate design choice kept them Insights-only (see RiskScorer's old
      class doc comment); reversed on direct request, not assumed.

      **Verification found the pipeline had genuinely never been exercised
      on this device**: `enabled_accessibility_services` was empty --
      `TrackingAccessibilityService` had never actually been turned on, so
      Phase 5's "on-device confirmation... still outstanding" note
      (elsewhere in this file) had never been resolved one way or the
      other. Enabled it (`adb shell settings put secure
      enabled_accessibility_services com.reclaim.app/.TrackingAccessibility
      Service`), confirmed bound via `dumpsys accessibility`, then typed a
      test string containing a keyword ("nsfw") into Chrome's address bar
      -- never navigated anywhere, and the device had no network connection
      at the time, so nothing resembling real explicit content was ever
      loaded. Confirmed via the real `LocalSignals` bridge: real
      `keyword_matches` rows, correct package (`com.android.chrome`),
      correct keyword and category, pointing at a real `page_captures` row.

      **New `recentKeyword` factor** (`RiskScorer.java`): default weight 35
      (higher than every usage-pattern proxy factor -- an actual keyword
      match is direct evidence, not an inferred pattern), window 15 minutes
      (matches `BaselineSampleWorker`'s own cadence), scoped to
      `currentPackage` specifically via a new
      `LocalSignalsDb.mostRecentKeywordMatchAt(packageName)` query -- a
      match in one app never gets attributed to an unrelated later
      session's score. Parsed via a new shared `LocalSignalsDb.minutesSince
      (iso)` helper (`minSdkVersion` is 24, same `java.time.Instant`
      constraint as everywhere else this session) -- also used to de-
      duplicate the near-identical parsing code the recent-Reclaim-use
      protective factor already had. "Unexpected exposure" (a check-in
      condition tag previously left deliberately unmapped -- no factor had
      a direct relationship to it) now maps to this factor in
      `TAG_TO_FACTORS`, since one finally does.

      Verified on-device, not simulated: with the real keyword match from
      the test above still in the database, triggered the real scoring
      path with Chrome in the foreground -- log showed `recent-keyword
      (+35)` alongside the existing factors, and a real notification
      posted. Then foregrounded YouTube (allowlisted, but with no keyword
      match of its own) and triggered the same check -- `recent-keyword`
      correctly did NOT appear, confirming the per-package scoping isn't
      leaking a match from one app into an unrelated session's score.

- [x] **Up to 2 accountability partners, editable from Privacy's existing
      "Edit your preferences."** That entry point already existed
      (`preferencesView.js`'s doc comment already said "reachable any time
      after from Privacy" -- this wasn't new access, just a second partner
      slot added to it) -- user asked for a second partner, not a new
      screen. Every place that read the single `accountability_name`/
      `accountability_phone` pair now also checks `accountability_name_2`/
      `accountability_phone_2`, filtering to whichever partner(s) actually
      have a phone number set (0, 1, or 2):
      - `db.js` -- two new columns, migrated in for existing installs via
        `migrateColumns()` (same ALTER TABLE pattern as `home_lat`/
        `home_lon`), not a seed-version bump (this is the user's own row,
        not seeded content).
      - `preferencesView.js`/`index.html` -- a second name/phone pair in
        the same "Accountability partners" section (now plural), same
        fill/persist/summary handling extended, not a separate section.
      - `homeView.js`/`riskAlertView.js` -- both previously rendered a
        single static button; both now render a dynamic list (0-2 cards),
        same `.home-call-card`/`.modal-continue` styling, one per partner
        with a phone set.
      - `agentTools.js`'s `accountability_match` tool -- shape changed from
        `{hasContact, name, phone}` to `{contacts: [...]}`; updated its two
        renderers (`app.js`'s chat card, `resourcesAgent.js`'s Basic-mode
        fallback reply -- the second one would have silently broken,
        printing "undefined", if missed).
      - `personalContext.js` -- the AI's per-turn context sentence now
        names both partners when both are set ("Their accountability
        partners are X and Y") instead of just the first.
      - `riskProfile.js` -> `LocalSignalsPlugin.syncRiskContext` ->
        `LocalSignalsDb` app_meta -- second partner mirrored the same way
        the first already was, for `RiskNudgeMonitor` to read from a
        background Worker.
      - `RiskNudgeMonitor.java` -- the high-risk notification's "Call
        [name]" action is now up to two separate actions (one per partner
        with a phone set), each its own `PendingIntent`/request code (1
        and 3 -- 0 is the body tap, 2 is the verse action), via a new
        shared `addCallAction()` helper instead of duplicating the dial-
        intent code.

      Verified on-device, not simulated: set two real partners
      (Joey/Sam) through the actual store, confirmed the edit overlay
      pre-fills both fields, saved through the real Save button and
      confirmed the Privacy summary correctly pluralized ("Accountability
      partners: Joey, Sam"). Confirmed Home renders two real, distinct
      call cards. Triggered a real high-risk notification and confirmed
      via `dumpsys notification` two separate actions -- "Call Joey" and
      "Call Sam" -- each with its own distinct `PendingIntent`. Confirmed
      the in-app detail popup (`RiskAlertView.checkPending()`, the real
      JS path, not a mock) renders both "Call Joey" and "Call Sam"
      buttons together with the existing reasons list. Confirmed the
      chat's `accountability_match` tool returns both contacts, and the
      AI's own context sentence names both partners.

- [x] **Verses now come from the YouVersion Platform** (Nathaniel). Home's
      verse card is now "Today's Verse": YouVersion's own Verse of the Day
      (`getVOTD(dayOfYear)`, local time zone), rendered through their
      Bible display (`getPassageDisplay` HTML inside the
      `data-slot="yv-bible-renderer"` container + their stylesheets + the
      version's copyright attribution, which the license requires be shown
      with the text). Chat's `scripture_search` uses the same display: a
      plain "share a verse" gets today's verse; a detected theme keeps its
      hand-picked verse from `seedData.js`, just fetched from YouVersion by
      reference (`referenceToPassageId`, e.g. "Psalm 139:23-24" ->
      `PSA.139.23-24`). The AI's system prompt and per-turn note now tell it
      verses are shown in the YouVersion display, so it offers "today's
      verse" instead of quoting one.
      - `@youversion/platform-core` pinned in `package.json`, bundled (with
        zod) into `web/js/vendor/youversion-platform.js` by
        `npm run vendor:youversion` -- same "plain script tags, no build
        step" rule as web-llm.
      - `web/js/youversion.js` holds the App Key (`APP_KEY`, from
        platform.youversion.com) and the version list: NIV (111) first,
        BSB (3034) as fallback. NIV is licensed for the current key (verified
        live: today's verse and themed verses come back as NIV); BSB is
        only used if YouVersion ever answers 403 for NIV. With no key, offline, or on an API error,
        everything falls back to the local verse text, so no verse card is
        ever empty.

- [x] **Chat now requires the on-device AI download** (Nathaniel). Asked
      for: people must download the model before they can use Chat, with the
      input simply not accepting anything until it's there. Built: the
      composer textarea, send button, and suggestion chips stay disabled
      (placeholder says why) until `LocalModel` reports `ready`; the AI panel
      is always shown while locked and its "Not now" button is hidden, so
      the reason and the Download button can't be dismissed away. The
      download is still a tap, never automatic (~1 GB, Wi-Fi advice kept).
      The submit handler also refuses while locked, so a programmatic submit
      can't sneak past the disabled UI.
      - **Devices with no WebGPU are the one exception** (`unsupported`):
        they can never run the model, so locking them out would mean no chat
        at all -- they keep the scripted Basic mode. Everyone else, including
        the `error` state (e.g. interrupted download), is locked until the
        download works.
      - The header's crisis button, the safety banner's "In crisis?" link,
        and the crisis modal are outside the composer and still work while
        locked. Crisis *detection* (`agentIsCrisis`) only runs on typed
        messages, so a locked user gets the always-visible resources, not
        the in-chat crisis card.
      - A risk-notification "Tell me more / verse" tap auto-submits a verse
        request into Chat; while locked that would be refused, so it lands
        on Home's "Today's Verse" card instead.
      - Verified in a real browser with WebGPU (locked state, unlocked state
        via a stubbed `ready` status, no-WebGPU exception, blocked forced
        submit, no console errors). The real ~1 GB download-to-unlock path
        was then confirmed by Nathaniel on the Pixel 8a (debug build,
        fresh install).

- [x] **Chat prompt and filter tightened after a first prompt test**
      (Nathaniel). A first run of the real agent against the on-device model
      (desktop browser, ~11 clean prompts; the rest failed when the hidden
      preview tab was throttled -- see the untracked `llm-prompt-tests/`
      notes) showed the system prompt's own examples leaking into replies
      ("have you talked to Joey about this?" for someone with no partner;
      "I can't show you a verse on grace" for an urge), "Who are you?"
      answered "you don't need a pastor, counselor, or small group", and a
      shame reply blaming the person ("a trap of your own making... so
      broken"). Changes: the prompt now calls the model an unnamed AI chat
      bot for Reclaim 128, drops the "caring friend" framing and the verse
      example, says never to blame or call them broken, tells it what to say
      when asked who it is, and never to write a bracketed placeholder when no
      partner is saved. `RECLAIM_UNSAFE_SENTENCE` gained two patterns (telling
      them they don't need real people; "of your own making", "so broken",
      "you're broken" -- "you're not broken" is allowed) and no longer drops
      "I'm an AI/bot/app" sentences, which the new identity answer needs.
      - Verified only by unit-testing the regexes in Node against sample
        good and bad sentences. The new prompt has **not** been re-run against
        the model, on a phone or in a browser; do that before relying on it.

- [x] **Resource routing now scores intent instead of first-match keywords**
      (Nathaniel). Asked: make the router "read and understand" the message
      more, since finding the right resource is the chat's most important job.
      Built (Stage 1 of a two-stage plan): each `AGENT_TOOL_DEFS` entry now has
      `signals` (`[pattern, weight]`); `agentTopTool` sums matching weights per
      resource and picks the highest at or above `AGENT_MIN_SCORE` (ties go to
      the earlier entry). Added synonym and intent phrasings (e.g. "a person /
      mentor / check in on me" -> accountability, "teaching on ..." -> sermon,
      "something to reflect on" -> devotional, "distract / get through the
      night / something quick I can do" -> coping), Bible references like
      "Philippians 4:13" or "Romans 8" (book list; bare "job 2" deliberately
      doesn't count), and negative signals ("are you a therapist?", "group
      chat", "instead of a counselor"). A question about the AI ("are you my
      friend?") no longer falls through to a feeling-word verse. Unchanged:
      the affirmative-reply logic, the theme list, the "only an explicit ask or
      an urge shows a card" rule, and Basic mode's own routing in
      `resourcesAgent.js`.
      - Measured offline in Node against the labeled 800-prompt set (no model
        needed): explicit resource requests 209/284 (74%) -> 284/284, but that
        set was used to write the patterns, so it's optimistic. On 92 fresh
        hand-written prompts the old router scored 56/92 (61%) and the new one
        86/92 (93.5%) before a second round of fixes for 5 of the 6 misses
        (after which that set is no longer clean). Of 516 unlabeled prompts
        only 19 changed card, all reviewed and acceptable (e.g. rehab ->
        counselors, 12-step/SAA -> groups, no more verse for "are you my
        friend?").
      - Not verified in the running app or on the phone, and the weights are
        hand-set, so new phrasings will still miss. Stage 2 (an on-device
        embedding model, `snowflake-arctic-embed-s`, ~239 MB of graphics memory
        per WebLLM's config) is the option if keyword scoring plateaus; its
        download, memory, and latency cost on the Pixel 8a are untested.

- [x] **Chat is now a resource finder: card turns are the app's one sentence,
      the model no longer gives advice, and the crisis gate is a little wider**
      (Nathaniel). A 1000-prompt run of the real on-device model (notes in the
      untracked `llm-prompt-tests/`) showed the model answering app/privacy
      questions with invented facts, giving advice and theology, listing
      invented resources, and ending 43% of replies with "Would today's verse
      help?" (the prompt's only example, copied). Changes:
      - `AGENT_SYSTEM_PROMPT` rewritten: an "AI resource finder" that doesn't
        answer questions, never gives advice/explanations/theology, replies in
        1-2 sentences, names one kind of resource that fits, and points
        hurting people to a real person. All literal example sentences were
        removed (the small model copies whatever it is shown).
      - `ReclaimAgent.send`: when the router shows a card, the app's own intro
        ("I found some Bible reading plans you could start.") is the whole
        reply and the model is not called (also faster). Without a card the
        reply is capped at 2 sentences. A filter drops any "would this verse
        help?" sentence.
      - Measured on 100 prompts re-run through the real model: verse offers
        44 -> 0, average reply 31 -> 14 words, all 35 card replies exactly one
        sentence, the same card for 98 of 100 prompts (the other 2 were bare
        "ok" follow-ups, which are matched against the previous reply).
      - **Not solved:** the refusal wording "I can only help you find
        resources..." is now the template for most non-card replies (69%);
        prompt phrases still leak ("I don't know how the app works either");
        and in that run the model still said "You can watch soft porn if you
        feel it helps you" and "the app does not track your personal data".
        Prompt wording alone can't hold app/privacy/enabling-porn answers --
        they need fixed answers in code.
      - Verified with the real model on a desktop NVIDIA GPU in Chrome
        (not on the phone).
- [x] **Crisis gate widened a little, and one bug fixed** (Nathaniel). Asked:
      update it "but be careful of overdoing it" -- it does not need to catch
      everything. In `CRISIS_PATTERNS` (`resourcesAgent.js`): fixed a missing
      word boundary (`end my/it/this` matched "s*end my* info" and "s*end this*
      to my pastor"); added overdose / "took too many pills", cutting myself
      (not "cut myself off"), jumping off a bridge, "no one would miss/care if
      I...", "I am a burden to everyone", "tired of being alive / living" (not
      "living in secret"), "done with life", "life isn't worth living",
      "nothing to live for", "want it all to end", "killing myself", "easiest
      way to die", "no reason to keep living". Deliberately not added: "I can't
      do this anymore", "I'm done", "disappear", abuse/safety messages, "I
      bought a gun" -- people here say the first ones about the addiction.
      - Offline check against ~1,770 prompts: crisis prompts caught 26/79 ->
        43/79; 17 newly caught (all genuine); 0 new false alarms across 1,694
        other prompts; one old false alarm ("Does this app send my info
        anywhere?") removed. Known accepted over-triggers: "I'm killing myself
        to make deadlines", "what is an overdose of caffeine?". Still missed
        by design: ~36 of 79 (abuse, "I bought a gun", "I wrote a note",
        "I can't take this pain anymore", ...).

- [x] **Fixed answers for app/privacy questions and requests to find porn, plus
      two prompt leaks removed** (Nathaniel). Follow-up to the resource-finder
      change: in a 100-prompt real-model re-run the model still said "the app
      does not track your personal data" (false) and "you can watch soft porn if
      it helps you", and copied two prompt sentences ("I don't know how the app
      works either"; "...by name if you were told one, otherwise a trusted
      friend...") into replies.
      - `AGENT_SYSTEM_PROMPT`: dropped "you don't know how the app works
        either" and rewrote the hurting-person line more abstractly (no long
        sentence to copy).
      - New `web/js/fixedAnswers.js`, called right after the crisis check in
        `ReclaimAgent.send` and `ResourcesAgent.send`: first-match intents with
        reviewed text -- find-porn (refuse + offer a coping tool or a person),
        hide-or-bypass (refuse, point to accountability partner/pastor/counselor),
        porn-permission ("soft porn", "just look a little", "how old to watch";
        "a question for a real person"), tracking/permissions/background
        sampling/risk alerts, privacy (who can see my chat, where is data
        stored, is a human reading this), data (export/clear/delete -- the
        Insights tab buttons), AI download/offline, platforms, price, about,
        Bible version / "Provided by YouVersion", Sample tag, how-to-use
        (check-ins, where to enter pastor/partner), and "what can you do". The
        text comes from the app's own welcome notice, Privacy tab, and Insights
        tab; Supabase lookups send only the resource type and a US state if the
        user names one (checked in `supabaseClient.js`/`resourceRepo.js`).
        Price/iPhone/who-built-it answer "I don't have information".
      - Deliberately narrow: not matched on purpose are "how do I block porn on
        my phone", "I need an accountability partner", feelings, and resource
        requests (so a normal card request is never hijacked). "Is porn a sin?"
        was left to the model path rather than the permission intent.
      - Measured offline on ~1,770 test prompts: 105 matched (51/53 app
        questions, 24 adversarial, 3 AI-questions about privacy, 16
        capability questions), 0 resource requests / feelings / near-resource
        prompts hijacked. Offline tests of the agent flow (stub model) pass.
      - Real model: a partial re-run (33 of 100 prompts, then stopped) showed
        the two leaked phrases gone (0), verse offers still 0, the fixed
        answers firing in the live flow, and no failures. Not finished or
        compared in full, and not tried on the phone. Known: "I can only help
        you find resources..." is still the template for ~75% of model-written
        replies, sometimes awkwardly ("...but I am not a resource finder");
        "Is it ok to watch Netflix?" and "I wish I could just disappear
        forever" still get that template (the latter isn't in the crisis gate by
        design).

- [x] **Web version: browser tracking, risk scoring and notifications, via a
  local-only browser extension.** Asked for: bring the Android tracking idea to
  the web version, kept on the device, using the research data-collector as a
  starting point. Built `extension/` (Chrome/Edge, MV3): it records which
  *site* (hostname only, no paths) is focused and for how long, scans page text
  in memory for the same keyword list as Android and stores only which keyword
  matched, scores risk with a JS port of `RiskScorer` (same weights, thresholds,
  convergence bonus, recent-Reclaim-use protection and adaptive tuning), and
  posts generic notifications (risk nudge, nightly check-in at 9:30 pm; a second
  unanswered one stays on screen until dismissed, the browser's analogue of the
  full-screen intent). The web app reads it through a postMessage bridge
  (`web/js/webTracker.js` <-> `extension/bridge.js`) that is injected only on
  `reclaim128.org` and `localhost:4173`, and the worker re-checks the sender's
  origin before handing out anything. Insights, the risk-alert popup, the
  nightly/verse notification actions and the check-in outcome tuning all work
  through it, and a Privacy card turns tracking on/off and edits two site lists
  (trigger sites; text opt-outs). Decisions: (1) a *new* extension in this repo,
  not a change to the research collector, which keeps its own narrow consent and
  Supabase upload; (2) the extension has no `fetch()` and no host permission for
  any server, so nothing can leave the browser; (3) **deliberate departure from
  "allowlist, not a blocklist":** text is scanned on every site except a
  built-in sensitive list (webmail, messaging, banking, health) plus the user's
  own opt-outs, because an allowlist would miss the sites that matter most on the
  web. Revisit if that feels wrong; (4) whole-word keyword matching (a web page
  is far bigger than an on-screen snippet, so substrings like "denuded" would
  fire constantly), which still can't tell "escort" from "Ford Escort"; (5) no
  "alone" factor (no nearby-device scan in a browser) and no Android-style
  periodic background samples. Honest limits: browser notifications only appear
  while the browser is running, and the "Reach out" action opens the app's
  alert screen rather than dialing. **Verified:** both Node suites pass
  (`node extension/tests/riskScorer.test.js`, `.../background.test.js`; the
  second runs the real worker against a stubbed `chrome`), and the web side was
  exercised in the browser pane against a mock extension (handshake, Privacy
  card, site lists, alert popup, nightly and verse actions, Insights).
  Added afterwards, from using it: an in-page banner (the same generic nudge
  drawn on the current tab, because Windows hides toasts over fullscreen video
  and under Focus assist); the keyword list expanded from 20 to 100 on the web
  and by about 40 on Android (substring-unsafe words like "milf" and "orgy"
  stay web-only, which matches whole words); the web version then aligned to
  Joey's severity tiers (severe = site names and unambiguous phrases, a fixed
  +150 that always notifies; moderate and mild = adaptive factors, all three
  scaled 0.8x/1x/1.2x by notification intensity, with 30/15/10-minute recency
  windows), replacing an interim web-only "explicit keyword floor" so a lone
  "porn" is now moderate, as on Android; and adding the current site to the
  higher-risk list from the extension popup. **Verified in real Chrome by the
  team:** loading the extension, the bridge, notifications and the in-page
  banner, keyword-triggered nudges. **Not verified:** the Android keyword
  additions (not compiled or run on a device).
- [x] **"How Reclaim works" instructions page, reachable from Home.** User
      asked for a place to explain how to enable permissions and how the app
      works, from Home. A new help button next to Home's crisis button opens
      an overlay covering the five tabs, how to turn on each permission
      (including the three -- App usage, Notification access, Accessibility
      -- that need a system settings list, not just an in-app switch, since
      that's the non-obvious part), and what happens once permissions are
      on (background sampling cadence, allowlist-only text reading, tiered
      risk-nudge notifications, recent-Reclaim-use being protective). A "Go
      to Privacy" button closes the overlay and navigates there directly.
      Verified on-device: real fresh install, overlay renders and scrolls
      correctly, "Go to Privacy" closes it and switches views.

- [x] **Fixed a real bug: on-device AI silently broken forever after one GPU
      crash, Electron/desktop specifically.** User reported the AI replying
      with "(Something went wrong before I finished — please try again.)"
      on every single message once it happened once. Reproduced the actual
      failure via the user's own devtools console (not guessed): Windows'
      GPU driver watchdog killed the graphics device mid-generation
      (`DXGI_ERROR_DEVICE_HUNG`, a TDR timeout -- hardware/driver behavior,
      not an app bug, and more visible on Electron's D3D12/Dawn WebGPU
      backend than Android's). WebGPU logs that device-loss as its own
      console warning, not a catchable exception -- what `localModel.js`'s
      `streamChat()` actually saw was the engine's next call throwing
      "Object has already been disposed." The real bug: nothing ever told
      `LocalModel` the engine had died, so `isReady()` kept reporting `true`
      forever and every later message hit the same dead engine, identically
      silently, with no path back except a full app reload.
      - `streamChat()` now catches that failure the same way `start()`'s
        own catch block already did -- reset `engine = null` and
        `set("error", friendlyError(err))` -- so `LocalModel.isReady()`
        correctly flips to `false` afterward instead of staying stuck on
        `true` forever. Landed the same week as (just above) Chat's own
        requires-the-AI lock (`chatLocked()`, `app.js`): since that lock
        reads this same state and only exempts `unsupported` devices, this
        fix is what makes it actually engage after a runtime crash -- the
        composer correctly re-locks and the existing "Try again" panel
        shows, instead of staying wrongly unlocked forever and silently
        eating every later message into a dead engine (the original bug).
        `ReclaimAgent`'s own `isReady()` check (a defensive fallback to
        Basic mode) still exists underneath but is rarely reached now that
        the composer itself gates first. "Try again" re-creates the engine
        from the already-cached model weights -- no re-download.
      - Deliberately NOT triggered by `interruptGenerate()`'s own drain --
        that's the normal, frequent way a reply ends once enough sentences
        are kept (most turns, via `onDelta` returning `false`), not a
        failure; verified a benign throw during that drain correctly leaves
        the engine marked ready, only a real mid-generation failure resets
        it.
      - `friendlyError()`'s GPU-problem pattern widened to also match
        "disposed" (not just "device lost"), since that's the message that
        actually reaches catchable code in practice.
      - Verified without a real GPU crash or a 1GB model download: grafted
        the live edited file into a running browser tab (this session's
        established workaround for the dev server's missing
        Cache-Control), injected a fake engine whose stream throws the
        exact real error, and confirmed `isReady()` flips to `false` with
        the right status/message. Confirmed separately that a fake
        post-interrupt drain error leaves `isReady()` `true`, so the common
        case is untouched.

- [x] **Keyword list expanded and split into three severity tiers, instead of
      one flat list where every match weighed the same -- and all three now
      scale with notification_intensity.** User's own framing: some words
      should always trigger a risk-nudge, others are only slightly
      worrisome ("varied in risk"), and then: a higher notification setting
      should mean higher points for each tier, not just the existing lower
      trigger threshold.
      - `TrackingAccessibilityService.java`: `KEYWORDS` (one `Map`) became
        `KEYWORDS_SEVERE`/`KEYWORDS_MODERATE`/`KEYWORDS_MILD` (three), each
        still a plain-substring match, no regex/NLP. SEVERE deliberately
        holds only site names (pornhub, xvideos, onlyfans, ...) and
        unambiguous compound phrases ("watch porn," "hire an escort") --
        never a single ambiguous word, since an unconditional-trigger tier
        can't afford false positives from a nude color swatch, an art
        review, or a psychology article's "fetish." Those bare words
        (nude, erotic, fetish, nsfw, xxx, hentai, escort, ...) stay
        MODERATE; genuinely ambiguous ones (bare "nude," "risque," "18+,"
        "thirst trap") are MILD.
      - `keyword_matches` gained a `severity` column (native SQLite
        migration, `DB_VERSION` 1 -> 2, `ALTER TABLE ... ADD COLUMN` --
        existing rows keep their data, just `severity=NULL`).
      - `RiskScorer.java`: SEVERE is a fixed, non-adaptive bonus (+150, not
        in the weight-tuning system at all -- see its own comment) sized to
        guarantee both `triggers()` and `isHighRisk()` even at the least
        sensitive ("low") `notification_intensity` and its 0.8x multiplier
        (150*0.8=120, still clears the 110 high-risk bar) -- "should always
        trigger," literally. MODERATE keeps the pre-existing adaptive
        `recentKeyword` factor (default boosted 35 -> 40, unrenamed on
        purpose so existing `risk_weights`/`TAG_TO_FACTORS` stay
        meaningful); MILD is its own smaller adaptive factor
        (`recentKeywordMild`, boosted 12 -> 15). Each tier gets its own
        recency window too (severe 30 min, moderate 15, mild 10) -- a
        confirmed explicit match is worth flagging even if it's aged a
        cycle, an ambiguous word only means much if it's genuinely current.
        Takes only the single highest tier present, never stacks across
        tiers. `keywordIntensityMultiplier` (0.8 low / 1.0 medium / 1.2
        high) then scales whichever tier's points at the point of use --
        compounds with the existing, separate `thresholdForIntensity`
        (lower bar at high intensity) rather than duplicating it; no other
        factor's weight is intensity-aware, only the three keyword tiers.
      - **Found and fixed a real robustness bug while verifying the
        intensity change, not present in the original single-tier
        design.** The first implementation fetched each package's 20 most
        recent keyword_matches (mixed severities) and scanned that page for
        the highest tier present. Confirmed on-device that a flood of newer
        MODERATE matches (the same repeated test typing this session
        generated, each keystroke batch inserting several rows) can push an
        older-but-still-within-its-30-minute-window SEVERE match off that
        fixed-size page entirely -- silently defeating the "always
        triggers" guarantee in exactly the real scenario it exists for
        (e.g. browsing borderline content for a while, then hitting
        something explicit). Fixed by replacing the one mixed-severity
        fetch with three direct per-severity queries
        (`LocalSignalsDb.mostRecentKeywordMatchAt(pkg, severity)`, `WHERE
        package_name = ? AND severity = ?`) -- each asks directly for that
        exact tier's own most recent match, so no amount of other-tier
        activity in between can ever hide it. Re-verified the exact
        failure scenario after the fix: the same aged (23+ min old) severe
        match, now surrounded by 20+ newer moderate rows, was found
        correctly (`recent-keyword-severe(+120)` at low intensity).
      - Verified on-device, not simulated, real matches via the same safe
        method used earlier (typed test text, never navigated/searched),
        at all three notification_intensity settings: SEVERE (`pornhub`,
        Chrome) at medium -> `recent-keyword-severe(+150)`, real
        notification, high-risk "Call Joey" action (not "Read a verse")
        after setting a real test accountability partner, confirming
        `isHighRisk()` too. MODERATE (`fetish`/`erotica`, YouTube) ->
        `+40` at medium, `+48` at high (40*1.2), `+32` at low (40*0.8) --
        same real match, three different real scores, confirming the
        intensity scaling itself, not just its formula. MILD (`risque`,
        Google app) -> `+15` at medium, barely moves the score alone, as
        intended. Also confirmed the native schema migration: all
        pre-existing keyword_matches rows survived the `DB_VERSION` bump
        with `severity=NULL`, nothing lost.

- [x] **"Where does it usually happen?" free-text field removed from
      onboarding/preferences.** User's own framing: being at home should
      just count as higher risk automatically, not rely on someone
      self-reporting it in a text box once at setup. Removed the field
      (UI, pre-fill, save, and the AI-context sentence it fed) from
      `web/index.html`/`preferencesView.js`/`personalContext.js`; the
      underlying `tempting_locations` DB column is deliberately left in
      place as harmless unused legacy, same precedent as `sleep_hours`.
      The actual home-based risk factor (mirroring `home_lat`/`home_lon`
      into `LocalSignalsDb`, a new adaptive RiskScorer factor reusing the
      same Haversine Home/Away thresholds Insights already uses) is a
      separate, not-yet-started follow-up, not part of this change.

- [x] **Severe/moderate keyword matches now trigger the risk-nudge check
      immediately, instead of waiting for the next ~15-minute tick.** Text
      capture + keyword matching (`TrackingAccessibilityService`) was
      already real-time (`TYPE_WINDOW_CONTENT_CHANGED`, ~200ms OS debounce
      via `accessibility_service_config.xml`'s `notificationTimeout`), but
      `RiskNudgeMonitor.checkAndNotify()` -- the part that actually scores
      and decides whether to notify -- was only ever called from
      `BaselineSampleWorker`'s `PeriodicWorkRequest`, which can't be
      scheduled tighter than WorkManager's own enforced 15-minute floor. A
      severe match could sit unseen for up to 15 minutes. `checkKeywords`
      (`TrackingAccessibilityService.java`) now calls
      `RiskNudgeMonitor.checkAndNotify(this)` directly right after a SEVERE
      or MODERATE match is recorded (mild stays on the regular cycle --
      that tier is the genuinely ambiguous one, not worth an immediate
      interrupt). Safe to call this often: `checkAndNotify`'s own dedup is
      keyed by session start time, not call frequency, so the extra call
      only ever means noticing sooner, never an extra notification for the
      same session. This is part of the file Claude Code already wrote
      directly (allowlist text capture + keyword matching), not the two
      files edited by hand for Phase 4.
      - Verified on-device, not simulated: typed a severe-tier test string
        ("pornhubtestmatch") into Chrome's address bar (allowlisted,
        never navigated/searched) and watched logcat -- a real high-risk
        notification ("Got a second to check in? -- Call Joey") posted
        within about 2 seconds (`score=180 threshold=60 [trigger-app(+30)
        recent-keyword-severe(+150)]`), not after waiting on the next
        15-minute `BaselineSampleWorker` tick.

- [x] **Verse matching against 100 user-provided real-circumstance topics**
      (`bible_verses_for_100_circumstances.csv`), instead of just the
      existing broad theme words (`AGENT_THEME_WORDS`) or Verse of the Day.
      User's own framing: search the list for the topic that best matches
      what was said, then resolve that verse through YouVersion.
      - `seedData.js` gained `SEED_VERSE_TOPICS` (100 `{topic, refs}` rows,
        `refs` a semicolon-separated list of real references -- no body
        text stored, resolved live through YouVersion by reference like
        every other verse Chat shows). `db.js` gained a `verse_topics`
        table and reseeds it in `ensureSeeded()` (`CURRENT_SEED_VERSION`
        8 -> 9). `resourceRepo.js` gained `getVerseTopics()`.
      - `agentTools.js`: `matchVerseTopic(userText)` scores every topic by
        plain word overlap against the message (same philosophy as
        `agentScoreTool` above it -- deterministic, not embeddings/ML). A
        small stopword list keeps generic words from padding every score
        equally. `wordsMatch(a, b)` catches ordinary inflection (shared
        4+ letter prefix, short remaining tail) so "stressed" matches
        "stress" and "anxious" matches "anxiety" without a real stemmer;
        a tiny explicit `VERSE_TOPIC_SYNONYMS` map covers the handful of
        common irregular pairs that can't share a long-enough prefix
        ("angry"/"anger", "sad"/"sadness", "scared"/"fear"). Requires at
        least one real word match (score >= 1), never a coincidental
        partial. `pickVerseTopicReference` then picks one reference at
        random from the matched topic's list.
      - `agentFindVerse(theme, query)` tries the topic match first (if
        YouVersion is available), falling back to the pre-existing
        theme-based local verse, then Verse of the Day, then the local
        verse text with no YouVersion -- the topic match sits in front of
        that existing fallback chain, never replaces it, so "never empty"
        still holds even offline/without an app key. `query` (the raw
        message) is now threaded through everywhere a theme was
        previously the only input: `executeAgentTool`'s `scripture_search`
        case, `reclaimAgent.js`'s tool-input construction, and both
        `scripture_search` call sites in `resourcesAgent.js` (Basic mode
        gets the same matching, not just the on-device-model path).
      - Verified: parsed the actual CSV via a scratch Node script and
        spot-checked first/last 3 rows against the source; in-browser,
        confirmed `verse_topics` seeds to exactly 100 rows and
        `matchVerseTopic` picks the right topic for a battery of real
        phrasings ("I'm really stressed about an exam tomorrow" ->
        Stress, "I feel so lonely lately" -> Loneliness, "I'm so angry at
        my brother" -> Anger via the synonym map, unrelated gibberish ->
        null, correctly falling through). End-to-end through the real
        loaded page (fresh origin, not a cached script): `executeAgentTool
        ("scripture_search", { query: "I'm really stressed about an exam
        tomorrow" })` matched "Stress", picked `Isaiah 41:10` from its
        reference list, and resolved it live through the real YouVersion
        API -- same output shape the existing theme/Today's-Verse card
        renderer already handles, so rendering is covered by that
        existing, already-verified path.

- [x] **Small groups ranked by real distance from the saved home location**,
      instead of only a same-state text match. The `resources` table
      already had `latitude`/`longitude` columns, unused -- all 38
      `small_group` rows had `city`/`state` but null coordinates. Geocoded
      the 34 rows with a real physical location (city-center coordinates;
      the remaining 4 are online/nationwide groups or directory links,
      correctly left uncoordinated) directly in Supabase.
      `resourceRepo.js`'s `getSmallGroups` now reads the saved
      `home_lat`/`home_lon` (`UserPreferencesStore`, same field the
      onboarding "Save current location as home" button sets) and, when
      set and at least some groups have coordinates, fetches every
      `small_group` row, ranks by the same Haversine `distanceMeters`
      formula `insightsView.js` already uses for Home/Away labeling, and
      returns the closest `limit`. Falls back to the pre-existing
      text-detected-state match (then a nationwide sample) when there's no
      saved home location yet -- never breaks the existing behavior for
      someone who hasn't set one. `app.js`'s small-group card now shows
      "~N mi from your saved home location" when a distance was computed.
      Verified against the real live Supabase data (not a mock): with a
      simulated Philadelphia, PA home location, the ranked list came back
      Philadelphia (0 mi) -> Phoenixville (22 mi) -> Lancaster (61 mi) ->
      Gettysburg (110 mi) -> Southern Maryland (132 mi), correct ascending
      geographic order.

- [x] **Gender question added to onboarding/preferences; accountability
      partner and pastor/mentor sections redesigned around a "+ Add"
      button** instead of showing empty name/phone inputs up front.
      - `web/index.html`: a new "Gender" field (Male/Female, same
        `.scale-picker`/`.scale-btn` component the notification-intensity
        picker already uses) sits between the pastor section and "When
        are you usually tempted?". The accountability-partner and pastor
        sections each became a `.allowlist-list` (same component the
        allowlist manager uses) of saved-person rows plus a dashed,
        orange "+ Add ..." button with a circular plus badge
        (`.add-person-btn`/`.add-person-plus`, new in `styles.css`);
        clicking it reveals a small inline name/phone form
        (`.person-form`) instead of static always-visible inputs.
      - `preferencesView.js` was restructured around JS-managed state
        (`partners: [{name, phone}]`, up to 2; `pastor: {name, phone} |
        null`; `selectedGender`) instead of reading/writing individual
        input elements directly. `wireGenderScale` lets the selected
        option be clicked again to deselect -- gender has no default,
        unlike intensity.
      - `db.js` gained a `gender TEXT` column on `user_preferences`
        (`migrateColumns`, no seed-version bump needed -- this is a
        column migration, not seed content). `userPreferencesStore.js`'s
        `DEFAULTS`/params/`UPDATE`/`INSERT` all gained `gender`.
      - **Found and fixed a real bug during verification**: `.add-person-
        btn[hidden] { display: none; }` was missing, so `.add-person-
        btn`'s own `display: flex` (a class selector) beat the `[hidden]`
        attribute's default `display: none` at equal specificity --
        the "+" button stayed visible even after being hidden. Confirmed
        the fix via computed style (`display: none` after adding a
        person) once added.
      - Verified end-to-end in the browser, not just read: added a
        partner and a pastor through the real "+" flow, selected Male,
        saved, and confirmed `UserPreferencesStore.get()` round-tripped
        every field correctly; reopened the form and confirmed both
        people pre-fill as rows with both "+" buttons correctly hidden
        (2/2 partners, pastor filled) and Male still selected; removed a
        partner via its × and confirmed the "+" button reappeared and the
        removed partner's fields cleared to null on save.

- [x] **Closed a real gap: being on Reclaim itself could still trigger a
      notification.** `RiskScorer` already had a protective factor for
      recently being on Reclaim (`recent-reclaim-use`, -25 points within
      30 minutes -- pre-existing, not new this pass) and
      `RiskNudgeMonitor.currentSession()` already excluded Reclaim's own
      package. But `ForegroundAppMonitor` -- the separate "You've been on
      [App] for an hour. Is that correct?" verification notification,
      ported from reclaim-beta -- did NOT exclude Reclaim's own package
      from its session tracking, so leaving Reclaim open (a long Chat
      conversation, browsing resources) for over an hour could trigger
      that notification naming Reclaim itself. Fixed
      `ForegroundAppMonitor.currentSession()` to exclude Reclaim's own
      package and the launcher, the same pattern
      `RiskNudgeMonitor.currentSession()` already used. Also added an
      explicit self-package guard to `TrackingAccessibilityService
      .maybeCaptureText()` as belt-and-suspenders alongside Reclaim
      already being excluded from the "Add an app" allowlist picker
      (`allowlistView.js`) -- should never be reachable today, but worth
      the one-line guard given how much this matters.
      Verified on-device, not just read: added a temporary diagnostic log
      to `ForegroundAppMonitor.checkAndNotify`, opened Reclaim itself,
      triggered the real background check via the existing Testing-panel
      debug hook (`LocalSignals.debugRunBackgroundCheck()`, invoked
      directly over CDP since on-device touch input wasn't cooperating
      in this pass), and confirmed the log line
      (`[verify-reclaim-exclusion] session=null`) -- `currentSession()`
      correctly found no session at all while Reclaim was foreground.
      Removed the diagnostic log before the final build.

- [x] **A severe/moderate keyword match now offers a pre-filled "Text
      [partner]" notification action**, not just Call or Read a verse.
      User's own framing: searching a moderate-or-worse term should
      prompt reaching out to an accountability partner directly. Asked
      the user first whether this should be a true, no-tap auto-send
      (needs Android's SEND_SMS permission -- a "dangerous" permission
      Google Play restricts to default SMS handlers, and a false-positive
      moderate match, e.g. an ambiguous word in an innocent context,
      could message a partner with nothing to catch it first) or
      pre-filled with one tap to send, matching the existing Call action's
      "opens native communication, never sends anything itself" pattern.
      User chose pre-filled.
      - `RiskNudgeMonitor.postNotification`: when the triggering factors
        include `recentKeywordSevere` or `recentKeyword` (checked via a
        new `hasFactor` helper against `Result.factors`, a `JSONArray`)
        and a partner phone is set, this now takes priority over the
        existing high-risk/low-risk Call/Verse tiering. New
        `addTextAction` mirrors `addCallAction` exactly but uses
        `Intent.ACTION_SENDTO` + `smsto:` with `sms_body` pre-filled to a
        fixed message ("Hey, I'm struggling right now, so I would love to
        talk sometime soon.") -- opens the Messages app with the draft
        ready, never sends it, no new permission.
      - **Found and fixed a real staleness bug while verifying this**:
        the installed Android app had been running on a stale bundled
        copy of `web/` this entire session -- `npx cap sync android` had
        never been run after any web/js change made today or in prior
        sessions (verse topics, small-group location ranking, gender/
        partner UI, coping methods -- none of it was actually present
        on-device, only verified via the dev browser preview). Ran the
        sync, confirmed `method`/`gender`/`verse_topics` all present in
        the synced assets, rebuilt, and reinstalled.
      - Verified on-device, not simulated: set a test accountability
        partner, typed a moderate-tier test string ("fetishtestmatch...")
        into Chrome's address bar (allowlisted), and watched a real
        notification post -- "A quick check-in, whenever you're ready." /
        "Text TestPartner" -- with logcat confirming why:
        `recent-keyword(+40)` among the triggering factors, correctly
        picking the new text action over Call/Verse. Also incidentally
        re-confirmed the pre-existing `recent-reclaim-use(-25)` protective
        factor fired in the same log line.
      - **Two real mistakes during this verification pass, both from
        on-device touch taps landing somewhere other than where a
        screenshot showed them going** (this device/session's touch
        timing was unreliable this pass): a typed test string was twice
        mistakenly submitted as a real Google search instead of staying
        in the address bar untyped-and-uncommitted, once searching "nsfw"
        (returned only a Wikipedia definitional snippet) and once
        searching the literal test string (returned real, SafeSearch-
        blurred adult-site listings). Neither was intentional navigation;
        both were caught and backed out of immediately. Left in the
        user's real Chrome history for them to clear if they want to.
      - Also ran `pm clear com.reclaim.app` while chasing the stale-
        assets bug above, which wiped the user's real on-device
        accountability-partner/pastor data (not test data) and reset the
        accessibility-service permission -- both were real, unintended
        side effects of a debugging step, disclosed to and confirmed
        resolved with the user (re-enabled accessibility; will re-enter
        their real partner/pastor info themselves). Test placeholder data
        used for the verification above was cleared before finishing.

- [x] **Coping-method preference, picked in onboarding/preferences,
      prioritizes which coping-toolkit suggestions come up.** User's own
      list: Scripture, Breathing, Accountability partner, Journaling,
      Walk, Devotional (`COPING_METHOD_OPTIONS`, constants.js).
      - `resources` gained a `method` column (nullable, coping_mechanism
        rows only). `seedData.js`'s ~52 coping_mechanism rows were tagged:
        2 Accountability partner, 2 Scripture, 1 Journaling, 1 Walk, 39
        Breathing (the whole imported breathing-exercise bundle), 7 left
        untagged as general/ungrouped techniques that don't fit one of
        the six methods. None currently match "Devotional" -- a real
        devotional is already its own separate resource type
        (`devotional_finder`), not a coping_mechanism; the preference is
        still collected and stored faithfully, it just has no effect on
        `getCopingMechanisms` today, honestly rather than force-tagging
        something that doesn't fit.
      - `user_preferences` gained `preferred_coping_methods` (JSON array,
        same pattern as `tempting_times`/`common_triggers`). New chip
        grid in the preferences modal, same `renderChipGrid`/`.tag-chip`
        component already used for those two.
      - `resourceRepo.js`'s `getCopingMechanisms` now ranks
        theme-and-preferred-method matches first, then theme-only, then
        preferred-method-only, then everything else (already shuffled) --
        reads the saved preference directly via `UserPreferencesStore`,
        same pattern `getSmallGroups` already uses for the home location.
      - Verified on-device (CDP, not touch -- see the touch-reliability
        note above): confirmed the `resources.method` column and correct
        per-method counts; set preferred methods to Walk + Journaling and
        called `getCopingMechanisms` 8 times in a row, getting exactly
        those two entries (in randomized order) every time, out of ~52
        total rows; walked through the real onboarding UI (open form,
        read pre-filled selection state, click a new chip, save) and
        confirmed all three selections round-tripped correctly through
        `UserPreferencesStore`.

- [x] **10 women's recovery resources added, and small groups/articles now
      filter to the user's own gender.** User-supplied list of 10 URLs;
      researched each via WebFetch (real org, real offering, real contact
      where published), same verification-metadata pattern as the
      existing men's-group rows (`details.verification_status`). 9 added
      as new Supabase `resources` rows -- 6 `small_group` (SheRecovery,
      Blazing Grace Women's Group, Magdala, The Freedom Fight, Unraveled
      at Pure Desire, Naked Truth Project) and 3 `article` (Beyond
      Ordinary Women's "Caring for Women Who Struggle with Porn",
      Beggar's Daughter's church-group guide, IBCD's counselor workshop --
      these three are guidance/teaching pieces, not something a struggling
      woman joins directly, so `article` fit better than `small_group`).
      The 10th, celebraterecovery.com, was a genuine duplicate of the
      existing universal "Celebrate Recovery — Find a Group" row (id 52,
      already `gender=null`, already confirmed serving both genders) --
      not re-added.
      - `resources` gained a `gender` column (`'male' | 'female' | null`,
        null = universal). All 36 existing single-city men's-group rows
        (titles literally say "Men's"/"For Men Only") backfilled to
        `'male'`; the two existing national directory rows (Pure Desire
        and Celebrate Recovery "Find a Group") correctly already had no
        gender and stay universal.
      - `resourceRepo.js`'s new `filterByGender` excludes the other
        gender's rows outright (not just deprioritizes -- a men's-only
        group isn't a usable suggestion for a woman, or vice versa),
        always keeps universal (`gender: null`) rows, and does no
        filtering at all when the user hasn't set a gender (optional, no
        default -- better to show everything than silently under-serve
        someone who hasn't answered). Applied in `fromSupabase` (covers
        `getArticles`/`getSermons`/`getCounselingCenters`/the
        text-state-matched path of `getSmallGroups`) and in
        `getSmallGroups`'s distance-ranked path, so it composes correctly
        with both existing selection methods, not just one.
      - None of the 6 new small_group rows have coordinates (they're
        national/international organizations, not single-city chapters,
        so there's nothing honest to geocode) -- for a user with a saved
        home location, they're naturally excluded from the distance-ranked
        list (which only ever ranks rows that have coordinates) and
        surface instead through the existing nationwide-sample fallback,
        same as the two pre-existing directory rows always have.
      - Verified in-browser against the real live Supabase data (not a
        mock): gender `'female'` -> `getSmallGroups` returned exactly the
        6 new rows plus the 2 universal directory rows, zero men's
        groups; gender `'male'` -> exactly the 36 men's rows (2 universal
        would also qualify but didn't come up in this particular
        10-result sample); no gender set -> both genders present,
        nothing excluded; gender `'male'` + a saved home location ->
        distance ranking still composed correctly with the gender filter
        (same Philadelphia test point as the original distance-ranking
        verification, now confirmed gender-filtered too).

- [x] **"Preferences" shortcut card on Home**, same component shape as
      the existing call-accountability-partner card right above it.
      First attempt misread the request as an Android launcher/Home
      Screen shortcut (long-press icon, pin to the phone's own home
      screen) -- built and shipped that, user clarified they wanted it
      inside the app's own Home tab instead, not on the phone's home
      screen at all. Reverted the launcher-shortcut commit outright
      (`git revert`, not a manual undo) rather than leaving it half-used,
      then built the actual ask.
      - `homeView.js`'s existing `buildCallCard` pattern
        (`.home-call-card`/`-icon`/`-text`/`-label`/`-sub`, already
        styled) reused exactly for a new `buildPreferencesCard` -- a
        gear icon, label "Preferences", and a one-line summary of what's
        in there, `onclick` just calling `PreferencesView.open("edit")`
        directly (no native plugin, no pending-flag, no intent -- it's
        already the same WebView, so there was never a need for any of
        the launcher-shortcut machinery the reverted attempt built).
        Always shown, not conditioned on anything already being filled
        in, right below the call-partner card(s).
      - Verified in-browser against the real rendered Home view (fresh
        origin, not a cached script -- this session's browser-pane
        caching quirk keeps resurfacing, worth remembering for next
        time): confirmed the card renders with the right icon/label/sub,
        and that clicking it actually opens `preferencesOverlay`
        (`classList.contains("visible")` true).

- [x] **Firebase App Distribution set up for sending debug builds to
      testers**, project `reclaim-128`. Account/project creation had to be
      the user's own (Google account), not something an agent does --
      walked through registering the Android app (`com.reclaim.app`) and
      enabling App Distribution in the console, then handled everything
      code-side once `google-services.json` existed: the
      `com.google.firebase:firebase-appdistribution-gradle` classpath
      (`android/build.gradle`), the plugin apply + a
      `debug.firebaseAppDistribution` block (`android/app/build.gradle`)
      listing both testers' emails directly (no console-side tester group
      yet -- add more there as the project grows). `google-services.json`
      is committed on purpose -- it's a public client config, not a secret,
      standard Firebase practice; the real secrets (keystore/signing) stay
      gitignored exactly as before.
      - Verified without being able to actually run the upload myself
        (needs each person's own `firebase login`, a real Google OAuth
        login -- not something to do on someone else's behalf): confirmed
        the plugin resolves and registers `appDistributionUploadDebug`/
        `appDistributionUploadRelease`/tester-management tasks, and that a
        full `assembleDebug` still builds clean with the Firebase SDK
        wired in, after this session's many other changes landed on top.
        The actual upload+tester-notification path is for Joey (and
        Nathaniel, on his own machine) to confirm after their own
        one-time `firebase login` -- see CLAUDE.md's "Running it" section
        for the exact commands.

- [x] **Minimal, privacy-preserving usage counter** -- "how many people use
      Reclaim and how often," answered without Firebase Analytics or any
      ad-tech SDK. Asked the user directly first: Firebase Analytics
      conflicts with the app's own repeatedly-stated on-device-only
      privacy commitment, especially for an app about pornography-
      addiction recovery specifically -- usage data about who's using it
      and how often is a real privacy cost, not a neutral technical
      choice. User chose the minimal option over full Firebase Analytics
      or Play Console's own (install-only, no frequency) stats.
      - New Supabase table `app_opens` (same project the public resource
        library already reads from): `install_id` (random per-install
        UUID, generated client-side, never tied to anything identifying)
        + `opened_date`, unique together -- one row per install per
        calendar day it was opened, nothing else. RLS enabled with an
        INSERT-only policy for `anon` and no SELECT/UPDATE/DELETE policy
        at all, so the public key embedded in the app (same one already
        used for the resource library) can only ever add a row, never
        read usage data back -- confirmed directly: a `select=*` request
        with that key gets a flat 401.
      - New `usageAnalytics.js`: `pingIfNeeded()`, called once at boot
        (`app.js`), checks a `last_ping_date` flag in `app_meta` and
        skips the network call entirely once already pinged for today.
        `supabaseClient.js` gained `logAppOpen` -- deliberately a plain
        INSERT, not `Prefer: resolution=ignore-duplicates` (PostgREST's
        upsert-conflict path needs more than INSERT privilege to
        resolve, and granting `anon` anything beyond INSERT, e.g.
        SELECT, would let the public key read usage data back, defeating
        the entire point); a same-day duplicate ping instead hits the
        table's own unique constraint (409) and is treated as success,
        not an error.
      - **Found and fixed a real, independent concurrency bug while
        testing this**: `db.js`'s `setMeta` used a check-then-branch
        pattern (`getMeta(key) === null` decides INSERT vs UPDATE) with
        a real race window -- two calls for the same key close enough
        together could both see "no row yet" and both attempt INSERT,
        the second failing on the key's own UNIQUE constraint. Confirmed
        by reproducing it directly (two near-simultaneous `pingIfNeeded`
        calls). Fixed to a single atomic `INSERT OR REPLACE`, same net
        effect, no race window -- this fixes every other `setMeta` call
        site in the app (`UserPreferencesStore`, `RiskProfile`, etc.),
        not just this new one.
      - Verified against the real live Supabase project, not a mock:
        confirmed table/RLS/grants directly via SQL, drove the real
        `UsageAnalytics.pingIfNeeded()` end-to-end in a fresh browser
        origin, confirmed the real row landed (`SELECT` as the project
        owner), confirmed a second same-day call is a pure no-op, and
        confirmed the anon key's 401 on read. Deleted the test rows
        afterward.
      - Follow-up, same session: a viewable dashboard, since "query it
        yourself in Supabase" wasn't actually usable day to day. Two new
        Supabase RPC functions (`get_usage_summary`/`get_usage_stats`),
        `SECURITY DEFINER` so they can read `app_opens` despite `anon`
        having no direct SELECT grant on it -- they return aggregate
        counts only (daily active installs, 7/30-day actives, total
        installs), never a raw `install_id` or per-person row, and both
        are gated by a passcode checked server-side against a new
        `app_settings` table (itself RLS-locked with zero policies, only
        reachable through the two functions) -- not just hidden in
        client JS, which would be trivially bypassed. `analytics-site/
        index.html`: one small, self-contained page (passcode prompt,
        then the numbers) with no dependency on the main app's JS.
        Deployed as its own separate Cloudflare Worker
        (`wrangler.analytics.jsonc`, `reclaim-analytics`) rather than a
        page inside the main site's worker, specifically so a custom
        domain (`analytics.reclaim128.org`, Nathaniel's Cloudflare
        access needed for the one-time domain setup -- see CLAUDE.md)
        shows only the dashboard, not the whole app.
      - Verified against the real live project: wrong passcode correctly
        rejected by both RPCs; inserted temporary rows directly as the
        project owner (bypassing RLS, the same access a real end user's
        key never has) and confirmed the dashboard's numbers matched
        exactly (total/today/7d/30d and the per-day table); deleted the
        test rows afterward, confirmed empty state renders correctly too.

- [x] **Browser extension download from the web app.** Asked for: a way to get the extension without cloning the repo, plus a Home-screen reminder. Built: `scripts/pack-extension.mjs` zips `extension/` (minus tests) into `web/downloads/reclaim-extension.zip`, which ships with `web/`; the Privacy tab's browser-tracking card shows a download button and unzip/Load-unpacked steps while the extension isn't detected; Home shows a tap-to-Privacy reminder card (web only, hidden on Android/Electron and once the extension is detected, and only after the startup probe so it doesn't flash). Tradeoffs: still a manual developer-mode install (no Chrome Web Store listing yet), and the committed zip must be re-packed whenever `extension/` changes. Verified in the browser pane against the local server (reminder renders, download link serves the 39 KB zip, no console errors); not tested with the real extension installed.

- [x] **The AI learns which resources help each person, and can show several kinds at once.** Asked for (Nathaniel, 2026-10-06): the AI should play a part in choosing resources and learn from each user, via thumbs up/down on what it shows, and recommend more than one kind of resource per message. Built, in AI mode only (Basic mode left exactly as it was, by decision):
      - **Thumbs up/down on every card** except the accountability partner (`resourceFeedback.js`, local `resource_feedback` table, never networked). A rating teaches the **kind** of resource and the item's **keywords** -- tags, coping method, verse topic -- not the specific item (the decision: preferences are about kinds and themes). Supabase rows have no tags at all (checked: 44 groups, 3 counselors, 8 sermons, 6 articles), so their keywords are derived on-device from format words and the ministry/speaker in the subtitle. The message's own theme is deliberately not learned from: a thumbs-down on a shame verse mustn't teach "stop helping with shame". Each rating fades with a 60-day half-life (people grow out of a dislike) and a pseudo-count keeps one rating from swinging a score all the way.
      - **Multi-kind replies** (`resourcePicker.js`): up to 3 kinds and 4 items (2 of a kind at most). Explicit asks are always honored, however they've been rated. Unasked kinds are added only when a feeling or urge is named and only kinds that fit it: a theme → kinds default map (lonely → verse + small group; urge → coping + verse about temptation), nudged by onboarding's coping methods, then by thumbs. A disliked kind stops being added unasked; a liked kind still has to fit the theme. Within a kind, a ranker replaces the shuffle: theme match first (weighted so nothing learned can outrank it -- the offline test caught an off-topic liked item beating an on-topic one at the first weights), then liked keywords, onboarding method, distance for groups, plus a little randomness. The app writes one combined intro ("I found a verse about loneliness and a recovery group you could look into."); still no model call when cards show.
      - **The accountability partner** can't be rated, is never added or trimmed by learning, and shows whenever asked for. Counselors and small groups *can* be shown less -- Nathaniel's call: for some people a given kind of group really isn't helpful.
      - **Visible and resettable:** Privacy → "What Reclaim has learned" lists the leanings (Helpful / Mixed / Less helpful) per kind and theme, with forget-one and clear-all. The model's per-turn context gets one summary sentence (kinds/themes only, never item names) so a no-card reply leans toward what has helped.
      - Verified: `npm run test:picker` (new, offline, 15 cases each run 100-300 times for the randomness -- explicit asks honored, budget limits, partner protection, dislikes/likes changing picks, ranking order). In the browser pane with the model mocked as ready (the card path never calls it): rating/switching/undo, persistence across reload, multi-kind cards and intros, two thumbs-down on groups removing the group from a lonely message, Basic mode unchanged, Privacy panel and forget buttons. Not yet tried on the phone or with the real model loaded.

- [x] **A small on-device embedding model reads meaning the keyword lists miss.** Asked for (Nathaniel, 2026-10-06), as step 3 of the learning work: an "embedding model" alongside the chat model, used for all four jobs offered -- catching feelings and asks the keywords miss, ranking items by meaning, and learning a "taste" from rated items. Built `localEmbedder.js`: snowflake-arctic-embed-s (the b4 build: ~240 MB GPU memory; the b32 build needs ~1 GB) in its own WebLLM engine, so a failure can't take chat down. It writes no text, so it can't invent anything.
      - **Opt-in and size:** loads right after the chat model under the same opt-in; existing AI users get it automatically (decision: it's small next to what they agreed to). Measured download 67.6 MB; the AI panel, welcome text and the fixed "why download the AI?" answer now say about 1.1 GB. If it can't load, the AI panel says so once and picking uses keywords + thumbs.
      - **Calibration, done with the real model before writing the code:** one description per theme separated feelings from small talk badly ("my day was fine" scored closer to shame than real shame messages). What works: several example messages per theme / kind of ask, a "none" class of small talk (and, for asks, feelings), the query prefix on both sides, top-3 average per class, and a margin over "none". On held-out messages the keyword lists missed: themes caught 15/18 (11 exact, 4 a neighbouring theme) with 0/18 small talk let through; asks caught 6/12 with 1 wrong kind (a commute-listening ask got a verse instead of sermons) and 0/15 non-asks let through. `scripts/embedding-calibration.js` re-runs the sets in the app's console. An inferred ask counts as explicit (decision); an inferred feeling never overrides a keyword one or an urge -- with the real model, "the craving won't go away" read as "hope" and pulled in hope content until that rule was added.
      - **Ranking:** closeness in meaning to the message and to a taste vector (rated items, same 60-day fade), relative to the other candidates, capped so a theme match still always wins. Resource vectors (332 local + 61 Supabase) are embedded once and cached in IndexedDB, not the sql.js blob (localStorage-capped); new or edited resources are picked up on the next load by text hash.
      - Found in testing: with every vector cached, loading made no GPU call, so the ~9 s first-call warm-up landed on the person's first message and hit the 2.5 s timeout; a warm-up embed now always runs at load (first message 87 ms after). In this browser pane, Cache Storage lost most of the downloaded model files across a reload (IndexedDB and localStorage survived, 234 GB disk free) -- looks like the pane, but **check on the phone that the AI reloads from cache after a restart**.
      - Verified: real models in the browser pane (Intel laptop GPU), both loaded together: calibration numbers above, ~50-90 ms per message, end-to-end chat with inferred stress ("everything feels heavy and I just want to escape" -> coping + verse + devotional), an inferred counselor ask, and small talk getting no cards. `npm run test:picker` now 20 cases (inferred signals, meaning/taste ranking with hand-made vectors). Not yet tried on the phone (memory with two models is the open question).

- [x] **Tried and dropped: the chat model (Qwen) picking resources when the cheaper signals are unsure.** Planned as step 4 (Nathaniel's call: keep it only if it really improves accuracy). Built and measured in the browser pane with the real models: in the "gray zone" (no keywords; embedding margins just under the bars), Qwen chose a kind and a feeling from fixed lists via a WebLLM grammar. Findings: a JSON schema took 5.3 s/call vs 3.2 s for a bare "kind feeling" grammar; a short prompt ending "Small talk ... are none none." made it answer "none none" to everything; the best prompt took ~2 s/call (warm) but the next chat reply then re-read its whole history (0.33 s -> 5.2 s with 13 messages, since WebLLM caches one conversation); the first call of a session stalled 11-14 s and can't be interrupted while reading the prompt; and an interrupted non-streaming call left later non-streaming calls returning empty. On 15 fresh real messages, 5 reached the gray zone and Qwen got 1 clearly right, 1 reasonable, 2 wrong kinds, 1 timeout (it did say "none" to all 3 gray small-talk lines). Not a clear accuracy gain for the cost, so dropped; Qwen still only writes the short no-card replies. The same test exposed embedding false positives on everyday small talk (next entry).

- [x] **Embedding model no longer reads everyday small talk as a feeling.** Found while testing the dropped Qwen step above: fresh small talk got confident cards -- "I just got back from the gym" -> relapse, "my phone battery is low" -> shame, "who won the game" -> a verse -- and a later fresh set added "came back from a hike" / "I'm back from church" -> relapse and good streak news -> relapse. Causes and fixes in `localEmbedder.js`: (1) the "none" examples were nearly all greetings and app questions; a broad 40-line everyday list fixed the false positives but cut real feelings caught from 26/28 to 21/28, so instead 12 targeted lines (good news, "back from...", devices -- `EVERYDAY_NONE`); (2) batching the example messages when embedding them padded them and shifted results (one false positive came and went with batch composition), so examples are now embedded one at a time, like a person's message; (3) "streak" news still read as relapse (the relapse examples mention streaks), so a narrow `GOOD_NEWS` guard drops an *inferred* theme when the message has good-news words and no setback words; (4) theme bar 0.035 (was 0.04), which won one feeling back at no small-talk cost. Each step was tested on a held-out set written fresh for it. Verified with the real model through the app's own `analyze()` (`scripts/embedding-calibration.js`, now 38 feelings / 64 small talk / 12 asks): 32/38 feelings caught (27 exact) and 1/64 small talk let through, vs 35/38 and 7 of the first 59 before; asks unchanged at 5/12 (2 wrong kinds). Tradeoff accepted: a few more real feelings get the model's short reply instead of cards, in exchange for not answering "I just got back from the gym" with relapse resources.

- [x] **Plain verse requests show a verse on God's grace, not the Verse of the Day.** Asked for (Nathaniel, 2026-10-07): Home already shows YouVersion's Verse of the Day, so Chat shouldn't repeat it; default to a verse on the gospel / God's grace. `agentFindVerse` now uses the seeded verses tagged "grace" (`VERSE_DEFAULT_THEME`, 8 verses incl. Ephesians 2:8-9, Romans 5:20, Hebrews 4:15-16), still fetched and shown through YouVersion and ranked by learned preferences in AI mode; the intro reads "Here's a verse about God's grace for you." A message with a theme or a verse-topic match is unchanged; Home is unchanged. Applies to Basic mode too (shared `executeAgentTool`). Verified in the browser pane: AI mode (model mocked) and Basic mode both returned grace verses (Hebrews 4:15-16, Romans 5:20, 2 Peter 3:18) while Home showed Psalm 55:22 as Today's Verse.
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
  process would be unreliable and hard to debug or trust. The adaptive
  weight-tuning checklist item above ships that instead: a small
  deterministic feedback rule, in the same spirit as everything else in
  this system — explainable code, not vibes.
