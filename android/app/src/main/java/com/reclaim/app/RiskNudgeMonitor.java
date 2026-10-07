package com.reclaim.app;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.usage.UsageEvents;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

/**
 * The plan's "risk analysis algorithm," phase one: real multi-factor scoring (RiskScorer), not a
 * single duration threshold. Goal per the plan is prediction, not reaction -- notice a lead-up
 * pattern (a flagged trigger app, during a time that's historically or self-reportedly hard for
 * this person) and intercept before a slip, rather than wait for direct evidence one is already
 * happening. See RiskScorer for the actual weights and reasoning.
 *
 * Runs from BaselineSampleWorker at the same ~15-minute cadence as ForegroundAppMonitor, which
 * this reuses the session-detection shape of, but is a real feature, not that class's
 * verification tool. Two things happen when it fires: a notification with a suggested action
 * tiered by RiskScorer.Result.isHighRisk() -- high risk suggests "Call [name]" (up to two, one
 * per accountability partner who has a phone number set -- opens the phone's own dialer
 * pre-filled, same tel:-only, on-device, user-confirms-the-call choice as the crisis modal, never
 * auto-dials or sends anything itself), anything lower suggests "Read a verse"
 * instead (its own action/PendingIntent, ACTION_OPEN_VERSE -- opens straight to Chat with a
 * scripture request already sent, skipping the risk-alert detail popup entirely) -- and, on the
 * SECOND consecutive one
 * left unanswered (not the first -- see NotificationTracking), an attempt to actually interrupt via
 * setFullScreenIntent(), the same mechanism calls/alarms use. User's own framing, twice over: one
 * ignored nudge might just be bad timing, but two in a row is worth escalating for; and a minor
 * score doesn't warrant the same ask as one well past the bar.
 *
 * Honest limit on that escalation, not worked around: Android deliberately blocks a background
 * app from stealing focus from whatever's actively in use, so a full-screen intent only reliably
 * takes over when the screen is off/locked (opens the app instead of the lock screen) -- it does
 * NOT yank focus away from another app you're actively using, on the second miss or any other.
 * That's Android's own anti-abuse design (enforced since Android 10), not a bug here, and not
 * something worked around -- see this session's discussion of why not.
 *
 * The notification text says specifically why (RiskNotificationText: "You've been on Instagram for
 * 22 minutes. Let's check in."), written from RiskScorer's trace with wording the on-device AI
 * authored while the app was open -- that is the default, a deliberate reversal of the earlier
 * always-generic text, decided by the user. A Privacy setting ("lock-screen detail", app_meta
 * "lock_screen_detail") switches back to the generic GENERIC_TEXTS below for anyone who doesn't
 * want it readable on a locked phone. Either way the keyword factors only ever say "something on
 * your screen caught our attention" -- never the word or what was seen. The fuller breakdown
 * (userReasons + the trace) goes to app_meta and is shown, with an AI-written explanation, once
 * the app is open. See PURPOSE.md.
 */
@SuppressWarnings("deprecation") // UsageEvents.Event.MOVE_TO_FOREGROUND/BACKGROUND, see ForegroundAppMonitor
final class RiskNudgeMonitor {
    private static final String TAG = "RiskNudgeMonitor";
    private static final long QUERY_WINDOW_MS = 2 * 60 * 60 * 1000;
    private static final String PREFS_NAME = "reclaim_app_risk_nudge";
    private static final String KEY_LAST_PACKAGE = "last_notified_package";
    private static final String KEY_LAST_SESSION_START = "last_notified_session_start";
    // _v2: this channel actually requested IMPORTANCE_DEFAULT the first time it was ever created,
    // before the "make it actually interrupt" pass below upgraded the code to ask for HIGH --
    // importance is locked in permanently per channel ID the first time Android sees it, so that
    // later change was silently no-op'ing on every device that had already run the old code
    // (confirmed via dumpsys: mImportance=3/DEFAULT despite the code saying HIGH). Same fix as
    // NightlyCheckinWorker/ForegroundAppMonitor: new ID, old one deleted below.
    private static final String CHANNEL_ID = "reclaim_app_nudge_v2";
    private static final String OLD_CHANNEL_ID = "reclaim_app_nudge";
    static final int NOTIFICATION_ID = 2; // distinct from ForegroundAppMonitor's -- package-private, MainActivity cancels it too

    // Read by MainActivity.onCreate()/onNewIntent(), same pattern as NightlyCheckinWorker's own
    // EXTRA_ACTION -- marks that the app was opened via this notification's body tap (or its
    // full-screen intent auto-launch, which reuses the same PendingIntent and can't be told apart
    // from a real tap at the receiving end -- both count as "responded," see
    // NotificationTracking's own comment on what that means). The "Call" action deliberately isn't
    // tracked this way: wrapping it through anything other than a direct, unmodified
    // PendingIntent.getActivity() to the dialer risks the exact background-activity-launch block
    // this session already hit and fixed for NightlyCheckinWorker -- not worth risking a
    // safety-adjacent feature (calling an accountability partner) just to count a tap.
    static final String EXTRA_ACTION = "risk_action";
    static final String ACTION_OPEN = "open_risk_alert";

    // Distinct from ACTION_OPEN: this is the "Read a verse" notification action specifically, not
    // a body tap -- MainActivity routes this one straight to Chat with a scripture request already
    // sent, skipping the usual risk-alert detail popup, so the button does what it actually says
    // instead of just reopening the app onto the same generic screen a body tap would.
    static final String ACTION_OPEN_VERSE = "open_verse_request";

    // Shorter than the nightly check-in's: this is about an in-the-moment risk window, not a
    // routine daily touchpoint -- stale well before half a day has passed.
    private static final long TIMEOUT_MS = 3L * 60 * 60 * 1000;

    private RiskNudgeMonitor() {}

    static void checkAndNotify(Context ctx) {
        // Free-text feedback from the overlay's flag page that the app never got to read (see
        // RiskFeedbackNotes): after a while it applies to everything that fired.
        RiskFeedbackNotes.flushStale(ctx);
        if (!hasUsageAccess(ctx) || !hasNotificationPermission(ctx)) return;

        Session session = currentSession(ctx);
        if (session == null) return;

        long sessionMinutes = (System.currentTimeMillis() - session.startedAt) / 60000;
        RiskScorer.Result result = RiskScorer.score(ctx, session.packageName, sessionMinutes);
        Log.d(TAG, "score=" + result.score + " threshold=" + result.threshold + " [" + result.reason + "]");
        if (!result.triggers()) return;

        SharedPreferences prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        // Only once per continuous session, keyed by its exact start time -- otherwise every
        // ~15-minute tick would re-notify for as long as the same app stays in the foreground.
        if (session.packageName.equals(prefs.getString(KEY_LAST_PACKAGE, null))
                && session.startedAt == prefs.getLong(KEY_LAST_SESSION_START, 0)) {
            return;
        }
        // Written only after the permission check above passes -- otherwise a session that first
        // crosses the threshold before notification permission is granted would burn this
        // one-shot dedup slot and silently never notify for it, even after granting permission.
        prefs.edit()
                .putString(KEY_LAST_PACKAGE, session.packageName)
                .putLong(KEY_LAST_SESSION_START, session.startedAt)
                .apply();

        postNotification(ctx, session.packageName, result);
    }

    // TEMPORARY test hook -- called from the Testing panel (Privacy tab, see PURPOSE.md), not
    // part of the real detection path. Runs the real scorer against whatever's actually
    // foreground right now, but skips the score threshold and the dedup check so a real
    // notification can be seen on demand instead of waiting for real conditions to align.
    static void debugForceNotify(Context ctx, String packageOverride, int minutesOverride) {
        Session session = currentSession(ctx);
        String packageName = session != null ? session.packageName : ctx.getPackageName();
        long sessionMinutes = session != null ? (System.currentTimeMillis() - session.startedAt) / 60000 : 0;
        // Optional overrides, so a test can score "N minutes on <that app>" without actually sitting
        // in it (the Testing panel's own timers can't fire while the app is backgrounded).
        if (packageOverride != null && !packageOverride.isEmpty()) {
            packageName = packageOverride;
            sessionMinutes = Math.max(0, minutesOverride);
        }
        RiskScorer.Result result = RiskScorer.score(ctx, packageName, sessionMinutes);
        Log.d(TAG, "[debug] score=" + result.score + " threshold=" + result.threshold + " [" + result.reason + "]");
        postNotification(ctx, packageName, result);
    }

    // TEMPORARY test hook -- clears the per-session dedup marker so a repeat test isn't silently
    // swallowed by "already notified for this session" while iterating.
    static void debugClearCooldown(Context ctx) {
        ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit().clear().apply();
    }

    private static boolean hasNotificationPermission(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true;
        return ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    private static final class Session {
        final String packageName;
        final long startedAt;
        Session(String packageName, long startedAt) {
            this.packageName = packageName;
            this.startedAt = startedAt;
        }
    }

    // Same event walk as ForegroundAppMonitor.currentSession, plus: the launcher never counts as
    // a session at all -- going home doesn't just fail the threshold, it doesn't even start the
    // clock, so a phone left on the home screen for 20 minutes never triggers this. Reclaim's own
    // package is excluded the same way, and deliberately: being ON Reclaim is never itself
    // something to flag someone for -- see RiskScorer's recent-reclaim-use protective factor,
    // which is the positive side of this same idea (being on Reclaim RECENTLY actively lowers
    // risk, not just "doesn't raise it").
    private static Session currentSession(Context ctx) {
        UsageStatsManager usm = (UsageStatsManager) ctx.getSystemService(Context.USAGE_STATS_SERVICE);
        if (usm == null) return null;
        long end = System.currentTimeMillis();
        UsageEvents events = usm.queryEvents(end - QUERY_WINDOW_MS, end);
        String ownPackage = ctx.getPackageName();

        String currentPackage = null;
        long sessionStart = 0;
        UsageEvents.Event event = new UsageEvents.Event();
        while (events.hasNextEvent()) {
            events.getNextEvent(event);
            if (event.getEventType() == UsageEvents.Event.MOVE_TO_FOREGROUND) {
                String pkg = event.getPackageName();
                if (pkg != null && (LocalSignalsDb.isLauncherPackage(ctx, pkg) || pkg.equals(ownPackage))) {
                    currentPackage = null;
                } else {
                    currentPackage = pkg;
                    sessionStart = event.getTimeStamp();
                }
            } else if (event.getEventType() == UsageEvents.Event.MOVE_TO_BACKGROUND
                    && event.getPackageName() != null
                    && event.getPackageName().equals(currentPackage)) {
                currentPackage = null;
            }
        }
        return currentPackage != null ? new Session(currentPackage, sessionStart) : null;
    }

    private static boolean hasUsageAccess(Context ctx) {
        android.app.AppOpsManager appOps = (android.app.AppOpsManager) ctx.getSystemService(Context.APP_OPS_SERVICE);
        int mode = appOps.checkOpNoThrow(
                android.app.AppOpsManager.OPSTR_GET_USAGE_STATS,
                android.os.Process.myUid(),
                ctx.getPackageName());
        return mode == android.app.AppOpsManager.MODE_ALLOWED;
    }

    // The generic fallback, used only when the user has turned "lock-screen detail" OFF (default
    // is ON -- see the class doc comment) or no specific text could be composed. Never names the
    // app or the pattern, so none of these may reveal anything. Several phrasings, picked at
    // random per post, purely so this doesn't read as the exact same robotic string every time.
    private static final String[] GENERIC_TEXTS = {
            "Reclaim wants to check in with you.",
            "Got a second to check in?",
            "Just checking in with you.",
            "Reclaim has a quick check-in for you.",
            "Checking in — got a moment?",
            "A quick check-in, whenever you're ready.",
    };

    private static void postNotification(Context ctx, String packageName, RiskScorer.Result result) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // HIGH, not DEFAULT: a full-screen intent needs a high-importance channel to actually
            // heads-up/take over -- see the class doc comment on what this can and can't do.
            nm.deleteNotificationChannel(OLD_CHANNEL_ID);
            nm.createNotificationChannel(new NotificationChannel(CHANNEL_ID, "Risk check-in", NotificationManager.IMPORTANCE_HIGH));
        }

        LocalSignalsDb db = LocalSignalsDb.getInstance(ctx);
        // One id for this nudge everywhere (pending alert, overlay): a verdict given on either
        // surface is then recognized as the same alert and counts once.
        long alertId = System.currentTimeMillis();
        db.setMeta("pending_risk_alert", buildPendingAlertJson(ctx, packageName, result, alertId));
        // Read (and cleared) by LocalSignalsPlugin.recordCheckinOutcome once a check-in actually
        // happens -- see RiskScorer's class doc comment for the adaptive-tuning loop this feeds.
        db.setMeta("pending_notification_factors", buildPendingFactorsJson(result));
        // Same escalate-on-a-miss pattern as NightlyCheckinWorker, not unconditional the way this
        // used to be: a single ignored risk nudge does nothing further, but a SECOND one in a row
        // (the previous occurrence went unanswered) escalates to a full-screen takeover attempt.
        // User's own framing: the first miss might just be bad timing, but being ignored twice in
        // a row is a real signal worth interrupting for.
        boolean escalate = NotificationTracking.recordSentAndShouldEscalate(ctx, NotificationTracking.TYPE_RISK);

        // Tapping the notification body (not the call action) opens the app -- app.js checks for
        // the pending alert above on boot and shows the detail screen instead of landing on Chat.
        Intent openApp = new Intent(ctx, MainActivity.class);
        openApp.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        openApp.putExtra(EXTRA_ACTION, ACTION_OPEN);
        PendingIntent openAppIntent = PendingIntent.getActivity(
                ctx, 0, openApp, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(ctx, CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("Reclaim")
                .setContentText(notificationText(ctx, db, packageName, result))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_REMINDER)
                .setContentIntent(openAppIntent)
                .setTimeoutAfter(TIMEOUT_MS)
                .setAutoCancel(true);

        if (escalate) {
            // Real, honest limit either way -- see the class doc comment: only reliably takes
            // over when the screen is off/locked. Android won't let a background app steal focus
            // from one actively in use, by design, and this doesn't try to work around that.
            builder.setFullScreenIntent(openAppIntent, true);
        }

        // Tiered suggested action -- user's own framing: a score that just cleared the bar
        // doesn't warrant the same ask as one well past it. High risk (see Result.isHighRisk)
        // suggests actually calling an accountability partner -- both, as separate actions, if
        // both are set -- anything lower suggests a lighter-touch action instead. Falls back to
        // the lighter action even at high risk if no partner's been set -- better than no
        // suggested action at all.
        //
        // An actual on-screen keyword match (severe or moderate -- not mild, that tier is the
        // genuinely ambiguous one) takes priority over the usage-pattern-only high-risk tiering
        // below: user's own framing, a real match is worth a direct nudge to reach out, not just
        // a call option. Pre-filled, not auto-sent -- same "opens native communication, never
        // sends anything itself" choice as addCallAction below, so a false-positive moderate match
        // (an ambiguous word in an innocent context) can't blindside a partner with a message the
        // user never saw or approved; they still have to actually tap Send.
        String phone1 = db.getMeta("accountability_phone");
        String phone2 = db.getMeta("accountability_phone_2");
        boolean hasPhone1 = phone1 != null && !phone1.trim().isEmpty();
        boolean hasPhone2 = phone2 != null && !phone2.trim().isEmpty();
        boolean keywordMatch = hasFactor(result.factors, "recentKeywordSevere") || hasFactor(result.factors, "recentKeyword");
        if (keywordMatch && (hasPhone1 || hasPhone2)) {
            if (hasPhone1) addTextAction(ctx, builder, 4, phone1, db.getMeta("accountability_name"));
            if (hasPhone2) addTextAction(ctx, builder, 5, phone2, db.getMeta("accountability_name_2"));
        } else if (result.isHighRisk() && (hasPhone1 || hasPhone2)) {
            if (hasPhone1) addCallAction(ctx, builder, 1, phone1, db.getMeta("accountability_name"));
            if (hasPhone2) addCallAction(ctx, builder, 3, phone2, db.getMeta("accountability_name_2"));
        } else {
            // Its own PendingIntent/extra, distinct from the body tap -- MainActivity routes
            // ACTION_OPEN_VERSE straight to Chat with a scripture request already sent, skipping
            // the risk-alert detail popup entirely, so this button does what it says instead of
            // just reopening the app onto the same generic screen a body tap would. A worship-music
            // suggestion was also asked for, but nothing in the app links to any yet -- not
            // building a button with nowhere real to go; add it once that content exists.
            Intent openVerse = new Intent(ctx, MainActivity.class);
            openVerse.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            openVerse.putExtra(EXTRA_ACTION, ACTION_OPEN_VERSE);
            PendingIntent openVerseIntent = PendingIntent.getActivity(
                    ctx, 2, openVerse, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            builder.addAction(0, "Read a verse", openVerseIntent);
        }

        nm.notify(NOTIFICATION_ID, builder.build());
        Log.d(TAG, "posted risk nudge notification");

        // The notification above stays as the fallback and the record; when the person has granted
        // "Display over other apps", a full-screen check-in covers whatever they're doing as well --
        // the whole point, since a notification is easy to ignore mid-slip. See RiskOverlay.
        if (RiskOverlay.canShow(ctx)) {
            RiskOverlay.Spec spec = new RiskOverlay.Spec();
            spec.text = overlayText(ctx, db, packageName, result);
            spec.appLabel = appLabel(ctx, packageName);
            spec.alertId = alertId;
            spec.factors = result.factors;
            // Always shown on the overlay: the person judges for themselves whether it's a false alarm.
            for (int i = 0; i < result.userReasons.length(); i++) spec.reasons.add(result.userReasons.optString(i));
            spec.partnerNames[0] = db.getMeta("accountability_name");
            spec.partnerPhones[0] = db.getMeta("accountability_phone");
            spec.partnerNames[1] = db.getMeta("accountability_name_2");
            spec.partnerPhones[1] = db.getMeta("accountability_phone_2");
            RiskOverlay.show(ctx, spec);
        }
    }

    // Specific text (default) from the trace + the AI's phrase bank, or the generic fallback when
    // lock-screen detail is off or nothing specific could be composed.
    private static String notificationText(Context ctx, LocalSignalsDb db, String packageName, RiskScorer.Result result) {
        return composeText(ctx, db, packageName, result, !"0".equals(db.getMeta("lock_screen_detail")), true);
    }

    // The overlay is drawn over an UNLOCKED, in-use screen (see RiskOverlay), so the lock-screen
    // privacy setting doesn't apply -- it always gets the specific sentence.
    private static String overlayText(Context ctx, LocalSignalsDb db, String packageName, RiskScorer.Result result) {
        String s = composeText(ctx, db, packageName, result, true, false);
        return s != null ? s : "Reclaim wants to check in with you.";
    }

    private static String composeText(Context ctx, LocalSignalsDb db, String packageName, RiskScorer.Result result,
                                      boolean detail, boolean genericFallback) {
        String text = null;
        if (detail && result.trace != null) {
            org.json.JSONObject bank = null;
            try {
                String raw = db.getMeta("phrase_bank");
                if (raw != null && !raw.isEmpty()) bank = new org.json.JSONObject(raw);
            } catch (org.json.JSONException e) {
                // Malformed bank -- RiskNotificationText falls back to its built-in phrases.
            }
            text = RiskNotificationText.compose(
                    result.trace.optJSONArray("factors"),
                    appLabel(ctx, packageName),
                    result.trace.optLong("sessionMinutes"),
                    result.trace.optString("timeBucket"),
                    bank, true, new java.util.Random());
        }
        if (text == null && genericFallback) return GENERIC_TEXTS[new java.util.Random().nextInt(GENERIC_TEXTS.length)];
        return text;
    }

    // ACTION_DIAL, not ACTION_CALL: opens the phone's own dialer pre-filled, doesn't place the
    // call itself -- the same "opens native communication, never sends anything" choice as the
    // crisis modal's tel: links, and needs no extra runtime permission. requestCode must be
    // distinct per action added to the same notification (1 and 3 here -- 0 is the body tap, 2 is
    // the verse action) or Android collapses them into the same PendingIntent.
    private static void addCallAction(Context ctx, NotificationCompat.Builder builder, int requestCode, String phone, String name) {
        Intent dial = new Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + phone.trim()));
        PendingIntent callIntent = PendingIntent.getActivity(
                ctx, requestCode, dial, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String label = "Call " + (name != null && !name.trim().isEmpty() ? name.trim() : "them");
        builder.addAction(0, label, callIntent);
    }

    // What the pre-filled text draft says -- never anything more specific than this (no app name,
    // no keyword, no severity) for the same reason the notification text itself stays generic.
    private static final String REACH_OUT_MESSAGE = "Hey, I'm struggling right now, so I would love to talk sometime soon.";

    // ACTION_SENDTO with smsto:, not SmsManager -- opens the Messages app pre-filled with the
    // draft, doesn't send it. Same "opens native communication, never sends anything itself"
    // choice as addCallAction above: no SEND_SMS permission needed (a protected permission Google
    // Play restricts to default SMS handlers), and the user still has to actually tap Send, so a
    // false-positive match can't message a partner without the user seeing and approving it first.
    private static void addTextAction(Context ctx, NotificationCompat.Builder builder, int requestCode, String phone, String name) {
        Intent sms = new Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:" + phone.trim()));
        sms.putExtra("sms_body", REACH_OUT_MESSAGE);
        PendingIntent textIntent = PendingIntent.getActivity(
                ctx, requestCode, sms, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String label = "Text " + (name != null && !name.trim().isEmpty() ? name.trim() : "them");
        builder.addAction(0, label, textIntent);
    }

    private static boolean hasFactor(org.json.JSONArray factors, String name) {
        for (int i = 0; i < factors.length(); i++) {
            if (name.equals(factors.optString(i))) return true;
        }
        return false;
    }

    // Machine-readable factor names (not the plain-language reasons above) plus a timestamp, so
    // recordCheckinOutcome can later tell which weights to nudge and whether the check-in that
    // triggered it happened soon enough after this notification to plausibly be related.
    private static String buildPendingFactorsJson(RiskScorer.Result result) {
        try {
            org.json.JSONObject obj = new org.json.JSONObject();
            obj.put("factors", result.factors);
            obj.put("postedAt", System.currentTimeMillis());
            return obj.toString();
        } catch (org.json.JSONException e) {
            return null;
        }
    }

    // The specific, plain-language detail (which app, which reasons) never appears in the
    // notification itself -- only here, read back by app.js once the app is actually open. See
    // GENERIC_TEXTS above.
    private static String buildPendingAlertJson(Context ctx, String packageName, RiskScorer.Result result, long alertId) {
        try {
            org.json.JSONObject alert = new org.json.JSONObject();
            alert.put("appLabel", appLabel(ctx, packageName));
            alert.put("reasons", result.userReasons);
            alert.put("occurredAt", LocalSignalsDb.isoNow());
            // What the in-app explanation is written from, and what the user's verdict on this
            // alert is applied to -- see RiskScorer's class doc ("Explainability") and
            // LocalSignalsPlugin.recordRiskFeedback. `id` makes a verdict idempotent per alert.
            alert.put("id", alertId);
            alert.put("factors", result.factors);
            alert.put("trace", result.trace);
            return alert.toString();
        } catch (org.json.JSONException e) {
            return null;
        }
    }

    // Falls back to the raw package name if the app was uninstalled between detecting the
    // session and posting the notification, or its label can't be resolved for any reason.
    private static String appLabel(Context ctx, String packageName) {
        try {
            PackageManager pm = ctx.getPackageManager();
            return pm.getApplicationLabel(pm.getApplicationInfo(packageName, 0)).toString();
        } catch (PackageManager.NameNotFoundException e) {
            return packageName;
        }
    }
}
