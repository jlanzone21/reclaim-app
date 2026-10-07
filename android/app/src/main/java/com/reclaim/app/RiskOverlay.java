package com.reclaim.app;

import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.InputType;
import android.util.Log;
import android.view.animation.LinearInterpolator;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The full-screen check-in: when RiskNudgeMonitor decides to nudge, this covers whatever is on
 * screen with a screen the person has to answer, the way a call or Microsoft Authenticator's
 * approval does -- because a notification is easy to swipe away mid-slip, which is when it matters.
 *
 * Why a native overlay window and not an activity: Android 10+ blocks a background app from
 * starting an activity (that is why the earlier setFullScreenIntent never took over -- on this
 * app's test phone it is also outright denied, "FSI_REQUESTED_BUT_DENIED"), and Android 15+
 * narrowed even the "Display over other apps" exemption for that. A TYPE_APPLICATION_OVERLAY window
 * needs only that one permission (SYSTEM_ALERT_WINDOW, which the person grants once in Settings --
 * that grant IS the consent, no separate toggle), draws instantly with no WebView cold start, and
 * stays on screen above every app, the launcher included, until answered.
 *
 * Main screen: the specific sentence (RiskNotificationText) and, always, the plain-language reasons
 * the scorer had -- so the person can judge for themselves whether this is a false alarm instead of
 * having to ask why -- then a daily passage to pray through (its reference and one-line description,
 * picked by RiskPassage: today's passage on the first nudge of the day, then the on-device AI's pick for
 * the situation), "Pray through <passage>" (opens the app into the 2-minute Lectio Divina meditation on
 * it, web/js/lectioView.js), Call <partner>, Find resources, "I'm okay" (disabled for a few seconds so
 * it's a choice, not a reflex tap) and, small and at the bottom, "This was a false alarm". On a high-risk
 * nudge the partner call comes before the meditation; otherwise the meditation is first (Nathaniel,
 * 2026-10-07). The passage replaced a short AI-picked verse (RiskVerse) that used to sit here. (A 988
 * crisis link was here and was removed at the user's request.)
 *
 * Feedback: answering the main screen (I'm okay, Call, Find resources) records NO signal -- it does not
 * move any weight. (It used to count as "fair" and raise the weights of the factors that fired; that is
 * a self-reinforcing loop -- a pointless nudge waved off with "I'm okay" would make the same situation
 * score higher next time -- so only an explicit flag moves the weights now.) The false-alarm link opens
 * a second screen: tap which parts
 * didn't fit and/or type why, then Send; or Skip to leave right away. Skip, and Send with reasons
 * picked, adjust the weights immediately (false alarm, those factors or all that fired). Typed
 * words with no reasons picked are left for the on-device AI to read the next time the app opens
 * (RiskFeedbackNotes) -- it decides which part they meant -- and every typed note is also kept as
 * context for the AI. Letting it time out (FAILSAFE_MS) is not an answer and records nothing.
 *
 * Honest limits, not worked around: Android gives no ordinary app a way to disable Home or Recents,
 * so this can't be "inescapable" -- it covers everything and stays up until answered, and pressing
 * Home does not remove an overlay window. That is also why it can never trap anyone: it removes
 * itself after FAILSAFE_MS no matter what, Home always works, and revoking the
 * permission in Settings kills it instantly. It only appears when the worker already found the
 * phone unlocked and in use (BaselineSampleWorker.isInActiveUse), and Keyguard hides overlays, so
 * it never shows over a lock screen.
 */
final class RiskOverlay {
    private static final String TAG = "RiskOverlay";
    private static final long FAILSAFE_MS = 10L * 60 * 1000;
    private static final int OKAY_WAIT_SECONDS = 5;

    // Same palette as the app (styles.css): navy surface, orange accent.
    private static final int NAVY = Color.parseColor("#06335d");
    private static final int NAVY_LIGHT = Color.parseColor("#0d4577");
    private static final int ORANGE = Color.parseColor("#fe8722");
    private static final int WHITE = Color.WHITE;
    private static final int MUTED = Color.parseColor("#b9c8d8");

    // Same wording as RiskExplainer.FACTOR_GUIDE (riskExplainer.js) -- the labels on the flag page.
    // Only factors the scorer can actually tune have a chip (the SEVERE keyword tier is fixed).
    private static final Map<String, String> FACTOR_LABELS = new HashMap<>();
    static {
        FACTOR_LABELS.put("triggerApp", "Being on an app or site you flagged");
        FACTOR_LABELS.put("duration", "How long you'd been there");
        FACTOR_LABELS.put("selfReportedTime", "A time of day you said is hard");
        FACTOR_LABELS.put("historicalTime", "A time of day that's been hard before");
        FACTOR_LABELS.put("socialMedia", "Social media");
        FACTOR_LABELS.put("alone", "No one else nearby");
        FACTOR_LABELS.put("recentKeyword", "Something on screen that matched a flagged word");
        FACTOR_LABELS.put("recentKeywordMild", "Something on screen worth noticing");
    }

    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static View current; // main thread only
    private static Runnable failsafe;
    private static Runnable countdown;

    private RiskOverlay() {}

    static boolean canShow(Context ctx) {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(ctx);
    }

    static final class Spec {
        String text;
        String appLabel;
        long alertId;
        JSONArray factors; // every factor that fired (ids)
        List<String> reasons = new ArrayList<>(); // plain-language, RiskScorer.Result.userReasons
        RiskPassage.Passage passage; // the daily passage to pray through; null before the app synced a plan
        boolean highRisk; // partner call before the meditation
        String sig = "K";
        String bucket = "";
        String[] partnerNames = new String[2];
        String[] partnerPhones = new String[2];
    }

    // Safe from any thread (the background Worker calls this). A second nudge while one is already
    // up is ignored -- never stack screens. `onFailure` runs (on the main thread) only if the overlay
    // could NOT be drawn -- permission gone, or the window manager refused -- so the caller can fall back
    // to a notification; it is not run when an overlay is already showing (a check-in is already up).
    static void show(Context ctx, Spec spec, Runnable onFailure) {
        Context app = ctx.getApplicationContext();
        MAIN.post(() -> {
            try {
                if (current != null) return;
                if (!canShow(app)) {
                    if (onFailure != null) onFailure.run();
                    return;
                }
                WindowManager wm = (WindowManager) app.getSystemService(Context.WINDOW_SERVICE);
                if (wm == null) return;
                View view = build(app, spec);
                wm.addView(view, layoutParams());
                current = view;
                failsafe = () -> dismiss(app, false);
                MAIN.postDelayed(failsafe, FAILSAFE_MS);
                view.requestFocus();
                Log.d(TAG, "overlay shown");
            } catch (Exception e) {
                // Permission revoked mid-call, no window token, etc. -- the notification already
                // posted is the fallback, so this must never throw into the Worker.
                Log.w(TAG, "couldn't show overlay", e);
                current = null;
                if (onFailure != null) {
                    try {
                        onFailure.run();
                    } catch (Exception inner) {
                        Log.w(TAG, "fallback notification failed too", inner);
                    }
                }
            }
        });
    }

    private static WindowManager.LayoutParams layoutParams() {
        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_SYSTEM_ALERT;
        WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
                type,
                // Focusable (no FLAG_NOT_FOCUSABLE) so the Back key reaches this view and can be
                // swallowed, and so the flag page's text box can take the keyboard; layout-in-screen
                // /no-limits so it covers the status bar too. The navigation bar is deliberately left
                // alone: Home must stay reachable.
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                        | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON,
                PixelFormat.OPAQUE);
        lp.gravity = Gravity.TOP | Gravity.START;
        // Pan, not resize: with NO_LIMITS the window can't shrink for the keyboard, so it slides up.
        lp.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_PAN;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }
        lp.setTitle("ReclaimCheckIn");
        return lp;
    }

    private static int dp(Context c, int v) {
        return Math.round(v * c.getResources().getDisplayMetrics().density);
    }

    private static TextView text(Context c, String s, int sp, int color, boolean bold) {
        TextView t = new TextView(c);
        t.setText(s);
        t.setTextSize(sp);
        t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    // A small clickable line of words, not a button.
    private static TextView link(Context c, String s, View.OnClickListener onClick) {
        TextView t = text(c, s, 14, MUTED, false);
        t.setPaintFlags(t.getPaintFlags() | android.graphics.Paint.UNDERLINE_TEXT_FLAG);
        t.setGravity(Gravity.CENTER);
        t.setPadding(dp(c, 8), dp(c, 12), dp(c, 8), dp(c, 12));
        t.setOnClickListener(onClick);
        t.setLayoutParams(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return t;
    }

    private static Button button(Context c, String label, boolean filled) {
        Button b = new Button(c);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextSize(16);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setTextColor(filled ? NAVY : WHITE);
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(dp(c, 14));
        if (filled) bg.setColor(ORANGE);
        else {
            bg.setColor(Color.TRANSPARENT);
            bg.setStroke(dp(c, 1), MUTED);
        }
        b.setBackground(bg);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(c, 54));
        lp.topMargin = dp(c, 10);
        b.setLayoutParams(lp);
        return b;
    }

    private static LinearLayout column(Context c) {
        LinearLayout col = new LinearLayout(c);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setGravity(Gravity.CENTER_VERTICAL);
        // Generous top padding clears the status bar/cutout the window extends under.
        col.setPadding(dp(c, 24), dp(c, 64), dp(c, 24), dp(c, 28));
        return col;
    }

    private static ScrollView scrollOf(Context c, LinearLayout col) {
        ScrollView scroll = new ScrollView(c);
        scroll.setFillViewport(true);
        scroll.addView(col, new ScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return scroll;
    }

    private static View build(Context c, Spec spec) {
        FrameLayout root = new FrameLayout(c);
        root.setBackgroundColor(NAVY);
        root.setFocusable(true);
        root.setFocusableInTouchMode(true);
        // Back is swallowed: it must not be a one-tap way past the check-in. Home still works.
        root.setOnKeyListener((v, keyCode, event) -> keyCode == KeyEvent.KEYCODE_BACK);

        ScrollView main = scrollOf(c, mainColumn(c, spec, root));
        ScrollView flag = scrollOf(c, flagColumn(c, spec, root));
        flag.setVisibility(View.GONE);
        root.addView(main, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(flag, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.setTag(new View[] {main, flag});
        return root;
    }

    private static void showPage(View root, boolean flagPage) {
        View[] pages = (View[]) root.getTag();
        pages[0].setVisibility(flagPage ? View.GONE : View.VISIBLE);
        pages[1].setVisibility(flagPage ? View.VISIBLE : View.GONE);
    }

    // ---- Main screen -------------------------------------------------------------------------

    private static LinearLayout mainColumn(Context c, Spec spec, View root) {
        LinearLayout col = column(c);

        TextView brand = text(c, "RECLAIM", 13, ORANGE, true);
        brand.setLetterSpacing(0.2f);
        col.addView(brand);

        TextView title = text(c, "Let's pause for a moment.", 28, WHITE, true);
        title.setPadding(0, dp(c, 10), 0, dp(c, 14));
        col.addView(title);

        TextView note = text(c, spec.text, 18, WHITE, false);
        note.setLineSpacing(0, 1.25f);
        note.setPadding(0, 0, 0, dp(c, 14));
        col.addView(note);

        // Always shown: the reasons, in plain language, so the person can judge whether this is a
        // false alarm without having to ask.
        if (!spec.reasons.isEmpty()) {
            TextView why = text(c, "WHY YOU'RE SEEING THIS", 12, MUTED, true);
            why.setLetterSpacing(0.12f);
            why.setPadding(0, dp(c, 4), 0, dp(c, 6));
            col.addView(why);
            for (String reason : spec.reasons) {
                TextView r = text(c, "•  " + reason.replace(" -- ", " — "), 15, WHITE, false);
                r.setLineSpacing(0, 1.15f);
                r.setPadding(0, dp(c, 3), 0, dp(c, 3));
                col.addView(r);
            }
            col.addView(new View(c), new LinearLayout.LayoutParams(1, dp(c, 10)));
        }

        // The daily passage to pray through, chosen for this situation (RiskPassage).
        if (spec.passage != null) col.addView(passageCard(c, spec.passage));

        // High risk: reach a person first, then the meditation. Otherwise the meditation leads.
        boolean hasPartner = false;
        for (String p : spec.partnerPhones) hasPartner |= p != null && !p.trim().isEmpty();
        boolean partnerFirst = spec.highRisk || spec.passage == null;
        if (!partnerFirst) addPrayButton(c, spec, col, true);
        for (int i = 0; i < 2; i++) {
            final String phone = spec.partnerPhones[i];
            if (phone == null || phone.trim().isEmpty()) continue;
            String name = spec.partnerNames[i];
            Button call = button(c, "Call " + (name != null && !name.trim().isEmpty() ? name.trim() : "your partner"), partnerFirst);
            call.setOnClickListener(v -> {
                // ACTION_DIAL, not ACTION_CALL: opens the dialer pre-filled and the person presses
                // call -- same choice as the notification's call action, no extra permission.
                launch(c, new Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + phone.trim())));
                answer(c, spec);
            });
            col.addView(call);
        }
        // No partner set: the meditation is the main button even on a high-risk nudge.
        if (partnerFirst) addPrayButton(c, spec, col, !hasPartner);

        // Opens the app's Chat with a "I need some help right now" message already sent, so the app's
        // own resource picker (coping tools, a verse, people to reach) answers -- see MainActivity.
        Button resources = button(c, "Find resources", false);
        resources.setOnClickListener(v -> {
            Intent open = new Intent(c, MainActivity.class);
            open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            open.putExtra(RiskNudgeMonitor.EXTRA_ACTION, RiskNudgeMonitor.ACTION_OPEN_RESOURCES);
            launch(c, open);
            answer(c, spec);
        });
        col.addView(resources);

        final OkayButton okay = okayButton(c);
        okay.root.setOnClickListener(v -> answer(c, spec));
        col.addView(okay.root);
        startOkayCountdown(okay);

        // Small and at the bottom, words not a button: the only thing that moves the weights, so it is
        // for when the check-in was wrong.
        LinearLayout bottom = new LinearLayout(c);
        bottom.setOrientation(LinearLayout.VERTICAL);
        bottom.setPadding(0, dp(c, 18), 0, 0);
        bottom.addView(link(c, "This was a false alarm", v -> showPage(root, true)));
        col.addView(bottom, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return col;
    }

    // The passage to pray through: a label, its reference and its one-line description, beside an orange bar.
    // Full passages are too long for a glance; the text itself is on the meditation screen, from YouVersion.
    private static View passageCard(Context c, RiskPassage.Passage p) {
        LinearLayout row = new LinearLayout(c);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setPadding(0, dp(c, 4), 0, dp(c, 8));
        View bar = new View(c);
        bar.setBackgroundColor(ORANGE);
        row.addView(bar, new LinearLayout.LayoutParams(dp(c, 3), ViewGroup.LayoutParams.MATCH_PARENT));

        LinearLayout body = new LinearLayout(c);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setPadding(dp(c, 12), 0, 0, 0);
        TextView label = text(c, p.today ? "TODAY'S PASSAGE" : "A PASSAGE FOR RIGHT NOW", 12, MUTED, true);
        label.setLetterSpacing(0.12f);
        body.addView(label);
        TextView ref = text(c, p.ref, 20, WHITE, true);
        ref.setPadding(0, dp(c, 4), 0, 0);
        body.addView(ref);
        if (!p.description.isEmpty()) {
            TextView desc = text(c, p.description, 16, WHITE, false);
            desc.setTypeface(Typeface.defaultFromStyle(Typeface.ITALIC));
            desc.setLineSpacing(0, 1.2f);
            desc.setPadding(0, dp(c, 4), 0, 0);
            body.addView(desc);
        }
        row.addView(body, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        row.setLayoutParams(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return row;
    }

    // "Pray through <passage>": opens the app into the 2-minute Lectio Divina meditation on it (MainActivity
    // writes the pending meditation; app.js opens lectioView.js). An answer like the others: no verdict.
    private static void addPrayButton(Context c, Spec spec, LinearLayout col, boolean filled) {
        if (spec.passage == null) return;
        Button pray = button(c, "Pray through " + spec.passage.ref, filled);
        pray.setOnClickListener(v -> {
            launch(c, RiskNudgeMonitor.meditationIntent(c, spec.passage, spec.sig, spec.bucket, spec.alertId));
            answer(c, spec);
        });
        col.addView(pray);
    }

    // "I'm okay" with the filling bar: same idea as the in-app dismiss button (a translucent bar fills left
    // to right behind the label over OKAY_WAIT_SECONDS, then the button wakes up) -- long enough to make it
    // a choice, not a reflex tap that clears the screen before it's been read, and the bar makes the wait
    // read as "counting down" rather than "the button is broken".
    private static final class OkayButton {
        FrameLayout root;
        View fill;
        TextView label;
    }

    private static OkayButton okayButton(Context c) {
        OkayButton b = new OkayButton();
        b.root = new FrameLayout(c);
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(dp(c, 14));
        bg.setColor(Color.TRANSPARENT);
        bg.setStroke(dp(c, 1), MUTED);
        b.root.setBackground(bg);
        b.root.setClipToOutline(true); // the bar is clipped to the rounded corners
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(c, 54));
        lp.topMargin = dp(c, 10);
        b.root.setLayoutParams(lp);

        b.fill = new View(c);
        b.fill.setBackgroundColor(Color.argb(90, 185, 200, 216));
        b.fill.setPivotX(0f);
        b.fill.setScaleX(0f);
        b.root.addView(b.fill, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        b.label = text(c, "I'm okay", 16, WHITE, true);
        b.label.setGravity(Gravity.CENTER);
        b.label.setAlpha(0.6f);
        b.root.addView(b.label, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        b.root.setEnabled(false);
        return b;
    }

    private static void startOkayCountdown(OkayButton okay) {
        okay.fill.animate().scaleX(1f).setDuration(OKAY_WAIT_SECONDS * 1000L).setInterpolator(new LinearInterpolator()).start();
        countdown = () -> {
            okay.root.setEnabled(true);
            okay.label.setAlpha(1f);
        };
        MAIN.postDelayed(countdown, OKAY_WAIT_SECONDS * 1000L);
    }

    // ---- Flag page ---------------------------------------------------------------------------

    private static LinearLayout flagColumn(Context c, Spec spec, View root) {
        LinearLayout col = column(c);
        col.setGravity(Gravity.TOP);

        TextView back = text(c, "← Back", 15, MUTED, false);
        back.setPadding(0, 0, dp(c, 16), dp(c, 12));
        back.setOnClickListener(v -> showPage(root, false)); // changed their mind: no verdict yet
        col.addView(back);

        TextView title = text(c, "What didn't fit?", 28, WHITE, true);
        title.setPadding(0, dp(c, 4), 0, dp(c, 8));
        col.addView(title);

        TextView sub = text(c, "Tap the parts that were wrong, or tell us in your own words. Or just skip — we'll still count this as a false alarm.", 15, MUTED, false);
        sub.setLineSpacing(0, 1.15f);
        sub.setPadding(0, 0, 0, dp(c, 14));
        col.addView(sub);

        // One chip per factor that fired AND can be tuned (see FACTOR_LABELS).
        final List<String> chosen = new ArrayList<>();
        if (spec.factors != null) {
            for (int i = 0; i < spec.factors.length(); i++) {
                final String id = spec.factors.optString(i);
                String label = FACTOR_LABELS.get(id);
                if (label == null) continue;
                final TextView chip = text(c, label, 15, WHITE, false);
                chip.setPadding(dp(c, 16), dp(c, 12), dp(c, 16), dp(c, 12));
                styleChip(c, chip, false);
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                lp.topMargin = dp(c, 8);
                chip.setLayoutParams(lp);
                chip.setOnClickListener(v -> {
                    boolean on = !chosen.contains(id);
                    if (on) chosen.add(id);
                    else chosen.remove(id);
                    styleChip(c, chip, on);
                });
                col.addView(chip);
            }
        }

        final EditText words = new EditText(c);
        words.setHint("In your own words (optional)");
        words.setHintTextColor(MUTED);
        words.setTextColor(WHITE);
        words.setTextSize(16);
        words.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        words.setMinLines(3);
        words.setGravity(Gravity.TOP | Gravity.START);
        words.setPadding(dp(c, 14), dp(c, 12), dp(c, 14), dp(c, 12));
        GradientDrawable box = new GradientDrawable();
        box.setCornerRadius(dp(c, 12));
        box.setColor(NAVY_LIGHT);
        words.setBackground(box);
        LinearLayout.LayoutParams wlp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        wlp.topMargin = dp(c, 16);
        words.setLayoutParams(wlp);
        col.addView(words);

        Button send = button(c, "Send feedback", true);
        send.setOnClickListener(v -> submitFlag(c, spec, chosen, words.getText().toString().trim()));
        col.addView(send);

        col.addView(link(c, "Skip", v -> submitFlag(c, spec, new ArrayList<String>(), "")));
        return col;
    }

    private static void styleChip(Context c, TextView chip, boolean on) {
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(dp(c, 12));
        if (on) {
            bg.setColor(ORANGE);
            chip.setTextColor(NAVY);
            chip.setTypeface(Typeface.DEFAULT_BOLD);
        } else {
            bg.setColor(Color.TRANSPARENT);
            bg.setStroke(dp(c, 1), MUTED);
            chip.setTextColor(WHITE);
            chip.setTypeface(Typeface.DEFAULT);
        }
        chip.setBackground(bg);
    }

    // The flag page's verdict: a false alarm, however much detail came with it.
    //  - reasons picked, or neither reasons nor words (Skip): adjust now -- those factors, or every
    //    factor that fired if none were picked.
    //  - words but no reasons picked: leave the weights for the on-device AI to attribute (it reads
    //    the words the next time the app opens); RiskFeedbackNotes flushes it to "everything that
    //    fired" if the app is never opened.
    // Any words are kept as a note either way (as context for the AI).
    private static void submitFlag(Context c, Spec spec, List<String> chosen, String words) {
        JSONArray picked = new JSONArray();
        for (String id : chosen) picked.put(id);
        boolean wordsOnly = !words.isEmpty() && chosen.isEmpty();
        if (!wordsOnly) {
            RiskScorer.applyFeedback(c, spec.alertId, picked.length() > 0 ? picked : spec.factors, false);
        }
        if (!words.isEmpty()) {
            RiskFeedbackNotes.add(c, spec.alertId, spec.appLabel, words, spec.factors, !wordsOnly);
        }
        Toast.makeText(c, "Thanks — I'll learn from that.", Toast.LENGTH_LONG).show();
        dismiss(c, true);
    }

    // Any way of answering the main screen. Counts as a RESPONSE (the notification stat, the notification is
    // cancelled) but records no verdict and changes no weight -- see the class doc, "Feedback".
    private static void answer(Context c, Spec spec) {
        dismiss(c, true);
    }

    // The overlay's own context can start activities (it is visible), unlike the Worker's.
    private static void launch(Context c, Intent intent) {
        try {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            c.startActivity(intent);
        } catch (Exception e) {
            Log.w(TAG, "couldn't launch " + intent, e);
        }
    }

    // `answered` false = the failsafe timed out: the person never responded, so it neither counts
    // as a response nor records a verdict nor cancels anything beyond the overlay itself.
    private static void dismiss(Context c, boolean answered) {
        MAIN.removeCallbacks(failsafe);
        MAIN.removeCallbacks(countdown);
        View v = current;
        current = null;
        if (v != null) {
            try {
                WindowManager wm = (WindowManager) c.getSystemService(Context.WINDOW_SERVICE);
                if (wm != null) wm.removeViewImmediate(v);
            } catch (Exception e) {
                Log.w(TAG, "removeView failed", e);
            }
        }
        if (answered) {
            NotificationTracking.recordResponded(c, NotificationTracking.TYPE_RISK);
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(RiskNudgeMonitor.NOTIFICATION_ID);
        }
    }

    // Test/diagnostic hook: is one up right now?
    static boolean isShowing() {
        return current != null;
    }
}
