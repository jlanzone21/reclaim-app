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
// ---- AI note bank: a complete pre-written note for this exact combination of reasons ----
assert.equal(N.noteSignature(new Set(["triggerApp", "duration", "selfReportedTime"])), "DT");
assert.equal(N.noteSignature(new Set(["socialMedia"])), "A");
assert.equal(N.noteSignature(new Set(["duration", "recentKeyword"])), null, "keyword: never an AI note");
assert.equal(N.noteSignature(new Set(["selfReportedTime"])), null);
const noteBank = {
  D: ["You've been on {app} for {minutes} minutes {time}. Take a moment to pause and check in."],
  DT: ["You've been on {app} for {minutes} minutes {time}, a hard time of day for you. Take a moment to pause and check in."],
  A: ["You're on {app} {time}. Please take a moment to pause and check in."],
};
assert.equal(
  N.compose({ ...base, trace: [f("triggerApp"), f("duration")], noteBank }),
  "You've been on Instagram for 22 minutes late tonight. Take a moment to pause and check in."
);
assert.equal(
  N.compose({ ...base, trace: [f("duration"), f("historicalTime")], noteBank }),
  "You've been on Instagram for 22 minutes late tonight, a hard time of day for you. Take a moment to pause and check in."
);
assert.equal(
  N.compose({ ...base, trace: [f("socialMedia")], noteBank, timeBucket: "Afternoon", app: "reddit.com" }),
  "You're on reddit.com this afternoon. Please take a moment to pause and check in."
);
// no note for this combination -> the per-factor phrases / built-ins, as before
assert.equal(N.compose({ ...base, trace: [f("alone"), f("duration")], noteBank }), "You've been on Instagram for 22 minutes. It's quiet around you right now. Let's check in.");
// a keyword nudge ignores the bank entirely (fixed line only)
const kwNote = N.compose({ ...base, trace: [f("recentKeyword"), f("duration")], noteBank });
assert.match(kwNote, /^Something on your screen caught our attention\./);
assert.ok(!/pause and check in/.test(kwNote));
// detail off -> generic, even with a bank
assert.equal(N.compose({ ...base, trace: [f("duration")], noteBank, detail: false }), null);
// unusable notes (digits, unknown slot, missing {minutes} for D, 3 sentences, too long) fall back
for (const bad of ["You've been on {app} for {minutes} minutes {time}, 20 times. Check in.", "Hey {name}, {app} {minutes}. Check in.", "You're on {app} {time}. Check in.", "A. B. C {app} {minutes}.", "x".repeat(210)]) {
  assert.equal(N.usableNote("D", bad), false, bad);
}
assert.equal(
  N.compose({ ...base, trace: [f("duration")], noteBank: { D: ["You're on {app} {time}. Check in."] } }),
  "You've been on Instagram for 22 minutes. Let's check in.",
  "a D note without {minutes} is ignored"
);
assert.equal(N.usableNote("A", "You're on {app} {time}. Please take a moment to pause and check in."), true);
console.log("notification text tests passed");
