// Run: node extension/tests/notificationText.test.js
const assert = require("node:assert/strict");
const N = require("../lib/notificationText.js");

const f = (id, fired = true, points = 10) => ({ id, fired, points, detail: "" });
const first = () => 0;
const base = { app: "Instagram", minutes: 22, timeBucket: "Night", bank: null, detail: true, pick: first };

// Detail off -> null: the caller keeps the generic wording.
assert.equal(N.compose({ ...base, trace: [f("duration")], detail: false }), null);
// Nothing fired / only unknown factors -> null, never an empty or half-built sentence.
assert.equal(N.compose({ ...base, trace: [f("duration", false)] }), null);
assert.equal(N.compose({ ...base, trace: [f("mystery")] }), null);

// Built-ins fill the live values.
assert.equal(N.compose({ ...base, trace: [f("duration")] }), "You've been on Instagram for 22 minutes. Let's check in.");
// Priority + the app is named once: duration leads, triggerApp (also names the app) is skipped,
// the time factor (doesn't) follows.
assert.equal(
  N.compose({ ...base, trace: [f("triggerApp"), f("duration"), f("selfReportedTime")] }),
  "You've been on Instagram for 22 minutes. This is a time of day you said is hard. Let's check in."
);
// Two time factors fire -> only one time sentence.
const t2 = N.compose({ ...base, trace: [f("selfReportedTime"), f("historicalTime")] });
assert.equal(t2, "This is a time of day you said is hard. Let's check in.");
// {time} is filled from the bucket.
assert.equal(N.compose({ ...base, trace: [f("socialMedia")] }), "You've been scrolling on Instagram late tonight. Let's check in.");

// Keyword factors: fixed line only -- no app, no word, no AI text, even if the bank tries.
const kw = N.compose({ ...base, trace: [f("recentKeywordSevere"), f("duration")], bank: { recentKeywordSevere: ["You looked at {app} porn"] } });
assert.equal(kw, "Something on your screen caught our attention. You've been on Instagram for 22 minutes. Let's check in.");
assert.ok(!/porn/i.test(kw));

// Bank phrases win over built-ins; the closer is bankable too.
assert.equal(
  N.compose({ ...base, trace: [f("duration")], bank: { duration: ["{minutes} minutes on {app}."], closer: ["Can we talk?"] } }),
  "22 minutes on Instagram. Can we talk?"
);
// Unusable bank entries (unknown placeholder, too long, two sentences) fall back to built-ins.
for (const bad of ["Hey {name}, check in.", "x".repeat(95), "One. Two sentences."]) {
  assert.equal(N.usable(bad), false, bad);
  assert.equal(
    N.compose({ ...base, trace: [f("duration")], bank: { duration: [bad] } }),
    "You've been on Instagram for 22 minutes. Let's check in."
  );
}
assert.equal(N.usable("Still on {app} after {minutes} minutes {time}."), true);
// Never longer than the cap: the second sentence is dropped before the text overflows.
const long = N.compose({
  ...base,
  trace: [f("duration"), f("selfReportedTime")],
  bank: { duration: ["A".repeat(60) + " {app} {minutes}."], selfReportedTime: ["B".repeat(70) + "."] },
});
assert.ok(long.length <= 150, long.length);
console.log("notification text tests passed");
