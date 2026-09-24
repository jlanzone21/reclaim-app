package com.reclaim.app;

import android.accessibilityservice.AccessibilityService;
import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Phase 1 (browser domain detection) ported from reclaim-beta's DomainAccessibilityService,
 * verified on-device there: reads ONLY the browser address bar, stores ONLY the host out of it --
 * never the full URL/path/query, never any other on-screen text.
 *
 * Phase 4 (system-wide app-open events) was attempted here and blocked by Claude Code's own
 * safety classifier on the accessibility_service_config.xml write -- the same block reclaim-beta
 * hit earlier for the identical change. See PURPOSE.md's "Decisions worth remembering" for what
 * this means going forward. Reverted rather than left half-applied.
 *
 * Purely passive: this only ever writes to its own SharedPreferences cache. Two things read it --
 * AccessibilityPlugin, for the foreground JS context, and the periodic sampler, which folds it
 * into every background checkin.
 */
@SuppressWarnings("deprecation") // AccessibilityNodeInfo.recycle() — deprecated on API 33+, still required below it (minSdk 24)
public class TrackingAccessibilityService extends AccessibilityService {
    static final String PREFS_NAME = "reclaim_app_accessibility";
    static final String KEY_DOMAIN = "detected_domain";
    static final String KEY_DETECTED_AT = "detected_at";

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

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        CharSequence pkg = event.getPackageName();
        if (pkg == null) return;

        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return;

        try {
            String addressBarText = readAddressBar(root, pkg.toString());
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
