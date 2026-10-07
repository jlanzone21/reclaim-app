// Run: node extension/tests/passagePicker.test.js
// Which daily passage a risk nudge offers to pray through (lib/passagePicker.js; the same rule as
// android/.../RiskPassage.java): today's passage first, then the AI's ranking for the situation, never one
// already offered or prayed through today, and the person's upcoming passages when there's no ranking.
const assert = require("node:assert/strict");
const P = require("../lib/passagePicker.js");

const DAY = 20733;
const plan = {
  passages: {
    "Romans 8:31-39": "Nothing can separate us from God's love.",
    "Psalm 23:1-6": "The Lord is my shepherd.",
    "1 Corinthians 10:12-13": "God provides a way out.",
    "Isaiah 41:10": "Do not fear, for I am with you.",
    "John 10:27-30": "No one can snatch you out of his hand.",
  },
  schedule: [
    { day: DAY - 1, ref: "Isaiah 41:10" },
    { day: DAY, ref: "Romans 8:31-39" },
    { day: DAY + 1, ref: "John 10:27-30" },
    { day: DAY + 2, ref: "Psalm 23:1-6" },
  ],
  ranked: { "DL|Night": ["Psalm 23:1-6", "Isaiah 41:10", "Romans 8:31-39"], "K|Night": ["1 Corinthians 10:12-13"] },
  used: { day: DAY, refs: [] },
};

// First nudge of the day: today's passage, whatever the situation.
let p = P.choose(plan, new Set(), "DL|Night", DAY);
assert.deepEqual(p, { ref: "Romans 8:31-39", description: "Nothing can separate us from God's love.", today: true });

// Later nudges: the best-ranked passage for THIS situation that hasn't been offered today.
const used = new Set(["Romans 8:31-39"]);
p = P.choose(plan, used, "DL|Night", DAY);
assert.equal(p.ref, "Psalm 23:1-6");
assert.equal(p.today, false);
used.add(p.ref);
assert.equal(P.choose(plan, used, "DL|Night", DAY).ref, "Isaiah 41:10", "never the same one twice in a day");
assert.equal(P.choose(plan, used, "K|Night", DAY).ref, "1 Corinthians 10:12-13", "a different situation has its own ranking");

// Prayed through in the app today (from Home) counts as used too -- the app's list arrives in the plan.
p = P.choose({ ...plan, used: { day: DAY, refs: ["Romans 8:31-39"] } }, new Set(), "DL|Night", DAY);
assert.equal(p.ref, "Psalm 23:1-6");
// ...but only on the day it was made for.
assert.equal(P.choose({ ...plan, used: { day: DAY - 1, refs: ["Romans 8:31-39"] } }, new Set(), "DL|Night", DAY).ref, "Romans 8:31-39");

// No ranking (no embedding model) or the ranking is used up: the upcoming daily passages, in order --
// not yesterday's.
const noRank = { ...plan, ranked: {} };
assert.equal(P.choose(noRank, new Set(["Romans 8:31-39"]), "DL|Night", DAY).ref, "John 10:27-30");
assert.equal(P.choose(noRank, new Set(["Romans 8:31-39", "John 10:27-30"]), "DL|Night", DAY).ref, "Psalm 23:1-6");
// Then anything not yet used; and when every passage has been offered, nothing (no repeats).
const all = Object.keys(plan.passages);
assert.equal(P.choose(noRank, new Set(all.slice(0, 4)), "A|Morning", DAY).ref, all[4]);
assert.equal(P.choose(noRank, new Set(all), "A|Morning", DAY), null);

// Nothing synced yet, or junk: no passage (the notification falls back to "Read a verse").
assert.equal(P.choose(null, new Set(), "K|", DAY), null);
assert.equal(P.choose({}, new Set(), "K|", DAY), null);
// References that aren't (or are no longer) daily passages are never offered.
p = P.choose({ ...plan, schedule: [{ day: DAY, ref: "Gone 1:1" }], ranked: { "K|Night": ["Gone 2:2", "Isaiah 41:10"] } }, new Set(), "K|Night", DAY);
assert.equal(p.ref, "Isaiah 41:10");

// Keys and days match the app's.
assert.equal(P.keyFor("DT", "Night"), "DT|Night");
assert.equal(P.keyFor(null, ""), "K|");
assert.equal(P.dayNumber(new Date(2026, 9, 7, 23, 59)), P.dayNumber(new Date(2026, 9, 7, 0, 1)));
assert.equal(P.dayNumber(new Date(2026, 9, 8)) - P.dayNumber(new Date(2026, 9, 7)), 1);

console.log("passage picker tests passed");
