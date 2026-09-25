package com.reclaim.app;

import android.accessibilityservice.AccessibilityService;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Phase 1 (browser domain detection) ported from reclaim-beta's DomainAccessibilityService,
 * verified on-device there: reads ONLY the browser address bar, stores ONLY the host out of it --
 * never the full URL/path/query, never any other on-screen text.
 *
 * Phase 4 (real-time app-open events): accessibility_service_config.xml's packageNames
 * restriction was removed so this service is system-wide. Every real window switch records one
 * identity-only app_events row (package + resolved label + timestamp) via recordAppOpen() below
 * -- never content -- deduped against the immediately-previous package so staying in one app
 * doesn't spam rows.
 *
 * Phase 5 (allowlist text capture + keyword matching): for apps on the user-editable allowlist
 * only (LocalSignalsDb.isAllowlisted), maybeCaptureText() walks the same AccessibilityNodeInfo
 * tree screen readers use, joins the visible text, and stores it verbatim in page_captures --
 * raw text is kept on-device by explicit user choice (see PURPOSE.md), not discarded after
 * matching. Every match against KEYWORDS gets one keyword_matches row pointing back at that
 * capture. Non-allowlisted apps never reach this path -- they still get the identity-only
 * app-open event above, nothing else.
 *
 * This file was edited by hand rather than by Claude Code directly for both Phase 4 and Phase 5 --
 * see PURPOSE.md's "Decisions worth remembering" for why.
 */
@SuppressWarnings("deprecation") // AccessibilityNodeInfo.recycle() — deprecated on API 33+, still required below it (minSdk 24)
public class TrackingAccessibilityService extends AccessibilityService {
    static final String PREFS_NAME = "reclaim_app_accessibility";
    static final String KEY_DOMAIN = "detected_domain";
    static final String KEY_DETECTED_AT = "detected_at";

    // Service instance is effectively a singleton while bound, so instance fields are enough to
    // dedupe consecutive events for the same foreground app / same visible text.
    private String lastLoggedPackage;
    private String lastCapturedText;

    // Best-effort: real device address-bar view-ids, which can shift between browser versions.
    // onAccessibilityEvent() falls back to a generic scan when a specific id no longer matches.
    private static final Map<String, String> ADDRESS_BAR_IDS = new HashMap<>();
    static {
        ADDRESS_BAR_IDS.put("com.android.chrome", "com.android.chrome:id/url_bar");
        ADDRESS_BAR_IDS.put("org.mozilla.firefox", "org.mozilla.firefox:id/mozac_browser_toolbar_url_view");
        ADDRESS_BAR_IDS.put("com.sec.android.app.sbrowser", "com.sec.android.app.sbrowser:id/location_bar_edit_text");
        ADDRESS_BAR_IDS.put("com.microsoft.emmx", "com.microsoft.emmx:id/url_bar");
        ADDRESS_BAR_IDS.put("com.opera.browser", "com.opera.browser:id/url_field");
        ADDRESS_BAR_IDS.put("com.brave.browser", "com.brave.browser:id/url_bar");
    }

    // Starter keyword list (plan says: hardcoded for now, editable list is a fast follow, not a
    // blocker to shipping the pipeline). Matched as a lowercase substring against captured text.
    // Category is stored alongside each match so Insights/future UI can group by kind later.
    private static final Map<String, String> KEYWORDS = new HashMap<>();
    static {
        KEYWORDS.put("porn", "explicit_content");
        KEYWORDS.put("pornography", "explicit_content");
        KEYWORDS.put("xxx", "explicit_content");
        KEYWORDS.put("nsfw", "explicit_content");
        KEYWORDS.put("nude", "explicit_content");
        KEYWORDS.put("nudes", "explicit_content");
        KEYWORDS.put("hentai", "explicit_content");
        KEYWORDS.put("erotic", "explicit_content");
        KEYWORDS.put("erotica", "explicit_content");
        KEYWORDS.put("fetish", "explicit_content");
        KEYWORDS.put("adult video", "explicit_content");
        KEYWORDS.put("adult film", "explicit_content");
        KEYWORDS.put("sexting", "explicit_content");
        KEYWORDS.put("onlyfans", "adult_site");
        KEYWORDS.put("pornhub", "adult_site");
        KEYWORDS.put("xvideos", "adult_site");
        KEYWORDS.put("xhamster", "adult_site");
        KEYWORDS.put("chaturbate", "adult_site");
        KEYWORDS.put("escort", "adult_site");
        KEYWORDS.put("strip club", "adult_site");
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        CharSequence pkg = event.getPackageName();
        if (pkg == null) return;
        String packageName = pkg.toString();

        if (event.getEventType() == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            recordAppOpen(packageName);
        }
        if (event.getEventType() == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED) {
            maybeCaptureText(packageName);
        }

        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return;

        try {
            String addressBarText = readAddressBar(root, packageName);
            String host = addressBarText != null ? parseHost(addressBarText) : null;
            if (host != null) storeDomain(host);
        } finally {
            root.recycle();
        }
    }

    @Override
    public void onInterrupt() {
        // Nothing to clean up.
    }

    // Identity-only: package + resolved label + timestamp. Never content. Deduped so staying in
    // one app doesn't write a row on every window-state blip within that same app. Excludes
    // Reclaim itself (not a distraction signal) and the device's launcher (going home isn't
    // "opening an app").
    private void recordAppOpen(String packageName) {
        if (packageName.equals(getPackageName())) return;
        if (LocalSignalsDb.isLauncherPackage(this, packageName)) return;
        if (packageName.equals(lastLoggedPackage)) return;
        lastLoggedPackage = packageName;
        String label = resolveLabel(packageName);
        LocalSignalsDb.getInstance(this).insertAppEvent(packageName, label, LocalSignalsDb.isoNow());
    }

    private String resolveLabel(String packageName) {
        try {
            PackageManager pm = getPackageManager();
            return pm.getApplicationLabel(pm.getApplicationInfo(packageName, 0)).toString();
        } catch (PackageManager.NameNotFoundException e) {
            return packageName;
        }
    }

    // Allowlist-gated: returns immediately for any app the user hasn't explicitly added. Walks
    // the node tree for visible text, skips if it's identical to the last capture (avoids writing
    // duplicate rows when a content-changed event fires without anything actually changing),
    // stores the raw text, then checks it against KEYWORDS.
    private void maybeCaptureText(String packageName) {
        if (!LocalSignalsDb.getInstance(this).isAllowlisted(packageName)) return;

        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return;

        String text;
        try {
            StringBuilder sb = new StringBuilder();
            collectText(root, sb, 0);
            text = sb.toString().trim();
        } finally {
            root.recycle();
        }

        if (text.isEmpty() || text.equals(lastCapturedText)) return;
        lastCapturedText = text;

        String capturedAt = LocalSignalsDb.isoNow();
        long captureId = LocalSignalsDb.getInstance(this).insertPageCapture(packageName, text, capturedAt);
        checkKeywords(packageName, text, captureId, capturedAt);
    }

    private void collectText(AccessibilityNodeInfo node, StringBuilder sb, int depth) {
        if (node == null || depth > 40) return;
        if (node.getText() != null) sb.append(node.getText()).append(' ');
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child == null) continue;
            try {
                collectText(child, sb, depth + 1);
            } finally {
                child.recycle();
            }
        }
    }

    private void checkKeywords(String packageName, String text, long captureId, String occurredAt) {
        String lower = text.toLowerCase(Locale.US);
        LocalSignalsDb db = LocalSignalsDb.getInstance(this);
        for (Map.Entry<String, String> entry : KEYWORDS.entrySet()) {
            if (lower.contains(entry.getKey())) {
                db.insertKeywordMatch(packageName, entry.getKey(), entry.getValue(), captureId, occurredAt);
            }
        }
    }

    private String readAddressBar(AccessibilityNodeInfo root, String pkg) {
        String knownId = ADDRESS_BAR_IDS.get(pkg);
        if (knownId != null) {
            String text = firstNodeText(root.findAccessibilityNodeInfosByViewId(knownId));
            if (text != null) return text;
        }
        // Fallback: the known id may have drifted with a browser update -- look for any editable
        // node near the top of the window whose text looks like a host, rather than giving up.
        return findHostLikeEditableText(root, 0);
    }

    private String firstNodeText(List<AccessibilityNodeInfo> nodes) {
        if (nodes == null || nodes.isEmpty()) return null;
        String text = null;
        for (AccessibilityNodeInfo node : nodes) {
            if (text == null && node.getText() != null) text = node.getText().toString();
            node.recycle();
        }
        return text;
    }

    private String findHostLikeEditableText(AccessibilityNodeInfo node, int depth) {
        if (node == null || depth > 6) return null;
        if (node.isEditable() && node.getText() != null) {
            String candidate = node.getText().toString();
            String host = parseHost(candidate);
            if (host != null) return host;
        }
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child == null) continue;
            try {
                String found = findHostLikeEditableText(child, depth + 1);
                if (found != null) return found;
            } finally {
                child.recycle();
            }
        }
        return null;
    }

    // Only ever returns a bare host (e.g. "example.com") — never scheme, path, query, or port.
    private static String parseHost(String raw) {
        if (raw == null) return null;
        String trimmed = raw.trim();
        if (trimmed.isEmpty()) return null;

        String host;
        if (trimmed.contains("://")) {
            host = Uri.parse(trimmed).getHost();
        } else {
            int cut = trimmed.length();
            for (String sep : new String[]{"/", " ", "?", "#"}) {
                int idx = trimmed.indexOf(sep);
                if (idx >= 0 && idx < cut) cut = idx;
            }
            host = trimmed.substring(0, cut);
        }
        if (host == null || host.isEmpty() || !host.contains(".") || host.contains(" ")) return null;
        return host;
    }

    private void storeDomain(String host) {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit()
                .putString(KEY_DOMAIN, host)
                .putLong(KEY_DETECTED_AT, System.currentTimeMillis())
                .apply();
    }
}
