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
        submit, no console errors). The actual ~1 GB download-to-unlock path
        and the Pixel 8a were not exercised.

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
