package com.reclaim.app;

import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * On-device store for everything the background collectors gather. Deliberately separate from
 * db.js's sql.js database: that one runs inside the WebView's JS context, which isn't guaranteed
 * to be loaded when a WorkManager Worker or the accessibility service fires. This is plain native
 * SQLite, written directly by native code, read by the WebView only through LocalSignalsPlugin.
 *
 * Nothing here is ever sent anywhere. See PURPOSE.md's privacy commitment.
 *
 * SQLiteDatabase handles its own locking, so a single shared instance (getInstance) is safe to
 * write from multiple threads (a Worker's background thread, the accessibility service's main
 * thread) without extra synchronization here.
 */
final class LocalSignalsDb extends SQLiteOpenHelper {
    private static final String DB_NAME = "reclaim_signals.db";
    private static final int DB_VERSION = 1;

    private static volatile LocalSignalsDb instance;

    static LocalSignalsDb getInstance(Context ctx) {
        if (instance == null) {
            synchronized (LocalSignalsDb.class) {
                if (instance == null) instance = new LocalSignalsDb(ctx.getApplicationContext());
            }
        }
        return instance;
    }

    private LocalSignalsDb(Context ctx) {
        super(ctx, DB_NAME, null, DB_VERSION);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        // Mirrors reclaim-beta's beta_checkins -- same periodic-sample shape, stored locally instead of Supabase.
        db.execSQL(
            "CREATE TABLE usage_samples (" +
            "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
            "  sampled_at TEXT NOT NULL," +
            "  local_hour INTEGER," +
            "  top_app_package TEXT," +
            "  coarse_lat REAL, coarse_lon REAL," +
            "  precise_lat REAL, precise_lon REAL," +
            "  nearby_device_bucket TEXT," +
            "  detected_domain TEXT," +
            "  recent_notification_package TEXT" +
            ")"
        );
        // Real-time app-open identity events (package + label + when) -- populated once the
        // accessibility service is widened system-wide. Never content.
        db.execSQL(
            "CREATE TABLE app_events (" +
            "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
            "  package_name TEXT NOT NULL," +
            "  app_label TEXT," +
            "  occurred_at TEXT NOT NULL" +
            ")"
        );
        // User-editable allowlist of apps whose on-screen text may be read. Nothing outside this
        // list is ever read beyond the identity-only app_events row above.
        db.execSQL(
            "CREATE TABLE allowlist_apps (" +
            "  package_name TEXT PRIMARY KEY," +
            "  app_label TEXT," +
            "  added_at TEXT NOT NULL," +
            "  is_default INTEGER NOT NULL DEFAULT 0" +
            ")"
        );
        // Raw captured on-screen text for allowlisted apps only. Kept on-device by explicit user
        // choice (see PURPOSE.md) -- not discarded after keyword matching.
        db.execSQL(
            "CREATE TABLE page_captures (" +
            "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
            "  package_name TEXT NOT NULL," +
            "  captured_text TEXT," +
            "  captured_at TEXT NOT NULL" +
            ")"
        );
        db.execSQL(
            "CREATE TABLE keyword_matches (" +
            "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
            "  package_name TEXT NOT NULL," +
            "  matched_keyword TEXT NOT NULL," +
            "  category TEXT," +
            "  capture_id INTEGER REFERENCES page_captures(id) ON DELETE CASCADE," +
            "  occurred_at TEXT NOT NULL" +
            ")"
        );
        // Small key/value table for one-off bookkeeping (e.g. "has the default allowlist been seeded").
        db.execSQL("CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT)");
        db.execSQL("CREATE INDEX idx_usage_samples_time ON usage_samples(sampled_at)");
        db.execSQL("CREATE INDEX idx_app_events_time ON app_events(occurred_at)");
        db.execSQL("CREATE INDEX idx_keyword_matches_time ON keyword_matches(occurred_at)");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        // No prior versions yet -- first real migration adds ALTER TABLE / CREATE TABLE steps here,
        // gated on oldVersion, the same pattern as db.js's migrateColumns().
    }

    // ---- usage_samples ----

    long insertUsageSample(ContentValues values) {
        return getWritableDatabase().insert("usage_samples", null, values);
    }

    JSONArray recentUsageSamples(int limit) {
        return queryRecent(
            "SELECT * FROM usage_samples ORDER BY sampled_at DESC LIMIT ?",
            limit
        );
    }

    // RiskScorer's solitude proxy: the most recent periodic sample's nearby-device count bucket,
    // however old -- there's no fresher signal to fall back to, and a somewhat-stale read is
    // better than treating "alone" as unknown every time.
    String mostRecentNearbyDeviceBucket() {
        Cursor c = getReadableDatabase().rawQuery(
            "SELECT nearby_device_bucket FROM usage_samples WHERE nearby_device_bucket IS NOT NULL ORDER BY sampled_at DESC LIMIT 1",
            null
        );
        try {
            return c.moveToFirst() ? c.getString(0) : null;
        } finally {
            c.close();
        }
    }

    // ---- app_events ----

    long insertAppEvent(String packageName, String appLabel, String occurredAt) {
        ContentValues values = new ContentValues();
        values.put("package_name", packageName);
        values.put("app_label", appLabel);
        values.put("occurred_at", occurredAt);
        return getWritableDatabase().insert("app_events", null, values);
    }

    JSONArray recentAppEvents(int limit) {
        return queryRecent(
            "SELECT * FROM app_events ORDER BY occurred_at DESC LIMIT ?",
            limit
        );
    }

    // ---- allowlist_apps ----

    void upsertAllowlistApp(String packageName, String appLabel, boolean isDefault) {
        ContentValues values = new ContentValues();
        values.put("package_name", packageName);
        values.put("app_label", appLabel);
        values.put("added_at", isoNow());
        values.put("is_default", isDefault ? 1 : 0);
        getWritableDatabase().insertWithOnConflict("allowlist_apps", null, values, SQLiteDatabase.CONFLICT_REPLACE);
    }

    void removeAllowlistApp(String packageName) {
        getWritableDatabase().delete("allowlist_apps", "package_name = ?", new String[]{packageName});
    }

    boolean isAllowlisted(String packageName) {
        Cursor c = getReadableDatabase().rawQuery("SELECT 1 FROM allowlist_apps WHERE package_name = ?", new String[]{packageName});
        try {
            return c.moveToFirst();
        } finally {
            c.close();
        }
    }

    JSONArray allAllowlistApps() {
        return queryRecent("SELECT * FROM allowlist_apps ORDER BY app_label ASC LIMIT ?", Integer.MAX_VALUE);
    }

    // Common browsers + a few high-scroll apps, matching what was actually discussed. Only ever
    // adds an entry for a package that's both installed on this device and not already present
    // (upsertAllowlistApp's is_default=true never overwrites a user's own later edit to the same
    // row's is_default flag -- but if the user removed a default, seeding again would silently
    // re-add it, so this only runs once, gated by app_meta below, not on every launch).
    private static final String[] DEFAULT_ALLOWLIST_PACKAGES = {
        "com.android.chrome", "org.mozilla.firefox", "com.sec.android.app.sbrowser",
        "com.microsoft.emmx", "com.opera.browser", "com.brave.browser",
        "com.google.android.youtube", "com.instagram.android", "com.zhiliaoapp.musically",
        "com.reddit.frontpage", "com.twitter.android", "com.snapchat.android", "com.facebook.katana",
    };

    void seedDefaultAllowlistIfNeeded(Context ctx) {
        SQLiteDatabase db = getWritableDatabase();
        Cursor c = db.rawQuery("SELECT value FROM app_meta WHERE key = 'allowlist_seeded'", null);
        boolean alreadySeeded;
        try {
            alreadySeeded = c.moveToFirst();
        } finally {
            c.close();
        }
        if (alreadySeeded) return;

        PackageManager pm = ctx.getPackageManager();
        for (String pkg : DEFAULT_ALLOWLIST_PACKAGES) {
            try {
                String label = pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString();
                upsertAllowlistApp(pkg, label, true);
            } catch (PackageManager.NameNotFoundException e) {
                // Not installed on this device -- fine, just don't add it.
            }
        }
        ContentValues marker = new ContentValues();
        marker.put("key", "allowlist_seeded");
        marker.put("value", "1");
        db.insertWithOnConflict("app_meta", null, marker, SQLiteDatabase.CONFLICT_REPLACE);
    }

    // ---- page_captures / keyword_matches ----

    long insertPageCapture(String packageName, String capturedText, String capturedAt) {
        ContentValues values = new ContentValues();
        values.put("package_name", packageName);
        values.put("captured_text", capturedText);
        values.put("captured_at", capturedAt);
        return getWritableDatabase().insert("page_captures", null, values);
    }

    void insertKeywordMatch(String packageName, String matchedKeyword, String category, long captureId, String occurredAt) {
        ContentValues values = new ContentValues();
        values.put("package_name", packageName);
        values.put("matched_keyword", matchedKeyword);
        values.put("category", category);
        values.put("capture_id", captureId);
        values.put("occurred_at", occurredAt);
        getWritableDatabase().insert("keyword_matches", null, values);
    }

    JSONArray recentKeywordMatches(int limit) {
        return queryRecent(
            "SELECT * FROM keyword_matches ORDER BY occurred_at DESC LIMIT ?",
            limit
        );
    }

    // ---- app_meta (generic key/value, e.g. the mirrored accountability contact) ----

    String getMeta(String key) {
        Cursor c = getReadableDatabase().rawQuery("SELECT value FROM app_meta WHERE key = ?", new String[]{key});
        try {
            return c.moveToFirst() ? c.getString(0) : null;
        } finally {
            c.close();
        }
    }

    void setMeta(String key, String value) {
        ContentValues values = new ContentValues();
        values.put("key", key);
        values.put("value", value);
        getWritableDatabase().insertWithOnConflict("app_meta", null, values, SQLiteDatabase.CONFLICT_REPLACE);
    }

    // ---- shared helpers ----

    // A launcher package varies by device/manufacturer (Pixel Launcher, One UI Home, Nova, ...),
    // so this resolves it dynamically via the HOME intent rather than hardcoding one -- the home
    // screen showing up as "foreground app" isn't a useful signal on any device, not just this one.
    //
    // resolveActivity(MATCH_DEFAULT_ONLY), not queryIntentActivities(MATCH_ALL): the latter lists
    // every component that merely DECLARES a HOME intent filter, which on stock Android/Pixel
    // includes com.android.settings/.FallbackHome (AOSP's safety-net home screen, used only when no
    // real launcher is set) -- confirmed on-device this made isLauncherPackage(ctx,
    // "com.android.settings") wrongly return true, silently excluding Settings from every session
    // this powers (RiskNudgeMonitor's currentSession, topRecentApp) even though Settings was
    // genuinely foreground. resolveActivity mirrors what the system actually launches for a HOME
    // press -- the one real default, not every declared candidate.
    static boolean isLauncherPackage(Context ctx, String packageName) {
        PackageManager pm = ctx.getPackageManager();
        Intent homeIntent = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME);
        ResolveInfo resolved = pm.resolveActivity(homeIntent, PackageManager.MATCH_DEFAULT_ONLY);
        return resolved != null && resolved.activityInfo != null && packageName.equals(resolved.activityInfo.packageName);
    }

    // yyyy-MM-dd'T'HH:mm:ss.SSS'Z' by hand rather than java.time.Instant: that needs API 26+
    // (or desugaring, not enabled here), and minSdk is 24 -- same reasoning as reclaim-beta's
    // BaselineSampleWorker.isoNow().
    static String isoNow() {
        java.text.SimpleDateFormat sdf = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US);
        sdf.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
        return sdf.format(new java.util.Date());
    }

    private JSONArray queryRecent(String sql, int limit) {
        Cursor c = getReadableDatabase().rawQuery(sql, new String[]{String.valueOf(limit)});
        JSONArray out = new JSONArray();
        try {
            while (c.moveToNext()) out.put(rowToJson(c));
        } finally {
            c.close();
        }
        return out;
    }

    private JSONObject rowToJson(Cursor c) {
        JSONObject row = new JSONObject();
        try {
            for (int i = 0; i < c.getColumnCount(); i++) {
                String col = c.getColumnName(i);
                switch (c.getType(i)) {
                    case Cursor.FIELD_TYPE_INTEGER: row.put(col, c.getLong(i)); break;
                    case Cursor.FIELD_TYPE_FLOAT: row.put(col, c.getDouble(i)); break;
                    case Cursor.FIELD_TYPE_NULL: row.put(col, JSONObject.NULL); break;
                    default: row.put(col, c.getString(i));
                }
            }
        } catch (JSONException e) {
            // Column names are our own fixed schema, never untrusted input -- this can't realistically throw.
            throw new RuntimeException(e);
        }
        return row;
    }
}
