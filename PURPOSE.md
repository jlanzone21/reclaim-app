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
- [ ] **Consent + permissions screen** — new to reclaim-app (it has none
      today). Same honest, skippable, per-permission design as
      reclaim-beta's, written for a real long-term user instead of a
      short-term anonymous tester.
- [ ] **Insights, for real** — currently renders only check-in data, and
      silently ignores `mood_rating`/`urge_intensity`/`sleep_hours` even
      though they're already collected. Fix that, and surface the new
      tracked data (recent usage samples, app-open events, keyword
      matches). This is also how we'll know collection is actually working.
- [ ] **Real-time app-open events** — system-wide (not browser-scoped)
      accessibility detection of which app is in the foreground, replacing
      reclaim-beta's ~15-minute polling approximation with the real thing.
      Identity only (package + label + timestamp), never content.
- [ ] **Allowlist-scoped text capture** — for apps the user explicitly adds
      to an editable allowlist (default: browsers + a few common apps),
      read on-screen text and check it against a keyword list. Raw text is
      kept on-device (the user's explicit choice, made with the tradeoff
      explained) rather than discarded after matching. Apps not on the
      allowlist only ever produce the identity-only open-event above —
      never their content.

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
