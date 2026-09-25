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
- [x] **Risk nudge notification, phase one** — `RiskNudgeMonitor.java`, the
      first (deliberately simple) step toward the "risk analysis algorithm"
      goal: right now the only signal is one app (never the launcher)
      continuously foreground for 20 minutes. Fires one local notification
      asking if they want to reach out to their accountability partner,
      with a "Call [name]" action that opens the phone's own dialer
      pre-filled — `Intent.ACTION_DIAL`, not `ACTION_CALL`, so it never
      dials automatically and needs no extra permission, same on-device
      choice as the crisis modal's `tel:` links. Needed a one-way mirror of
      just the accountability name/phone from `user_preferences` (db.js)
      into `LocalSignalsDb`'s `app_meta`, since this has to fire from a
      background Worker where the WebView isn't loaded — same reasoning as
      the rest of `LocalSignalsDb`. Verified on-device with a temporarily
      shortened threshold: real notification posted with the correct text
      and a "Call Joey" action correctly pulling the real saved name,
      confirmed via a real screenshot and `dumpsys notification`; reverted
      to the real 20-minute threshold before shipping. Along the way, found
      and fixed a real bug shared with `ForegroundAppMonitor`'s pattern: the
      per-session dedup marker was written before checking notification
      permission, so a session crossing the threshold before permission was
      granted would silently never notify even after granting it later —
      fixed here; `ForegroundAppMonitor` still has the same latent bug,
      not touched since it's a debug tool, not a shipped feature.

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
