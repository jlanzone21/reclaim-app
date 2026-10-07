// Checks Home's daily-passage rotation (web/js/dailyPassage.js) with a stubbed app_meta store.
// Run: node tests/dailyPassage.test.js (part of npm test).
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert/strict");

const js = (f) => fs.readFileSync(path.join(__dirname, "..", "web", "js", f), "utf8");

function load(passages) {
  const meta = {};
  const sandbox = {
    Math, JSON, Date, console,
    DB: { getMeta: (k) => (k in meta ? meta[k] : null), setMeta: (k, v) => (meta[k] = v), scheduleSave() {} },
  };
  const ctx = vm.createContext(sandbox);
  // A given list stands in for seedData.js (whose own `const DAILY_PASSAGES` would shadow it).
  if (passages) sandbox.DAILY_PASSAGES = passages;
  else vm.runInContext(js("seedData.js") + "\n;this.DAILY_PASSAGES = DAILY_PASSAGES;", ctx, { filename: "seedData.js" });
  vm.runInContext(js("dailyPassage.js") + "\n;this.DailyPassage = DailyPassage;", ctx, { filename: "dailyPassage.js" });
  return { D: sandbox.DailyPassage, meta, all: sandbox.DAILY_PASSAGES };
}

const day = (n, hour = 9) => new Date(2026, 9, 7 + n, hour); // local calendar days from Oct 7, 2026
const ref = (p) => p && p.reference;

// Every passage has a reference and a description (kept for the 2-minute devotional).
{
  const { all } = load();
  assert.equal(all.length, 35);
  assert.ok(all.every((p) => /\d+:\d+/.test(p.reference) && p.description.length > 20));
  assert.equal(new Set(all.map((p) => p.reference)).size, all.length, "no duplicate references");
}

// Same passage all day; each of the 35 shown exactly once before any repeats.
{
  const { D, all } = load();
  assert.equal(ref(D.today(day(0, 6))), ref(D.today(day(0, 23))), "stable within a day");
  const round = Array.from({ length: all.length }, (_, i) => ref(D.today(day(i))));
  assert.equal(new Set(round).size, all.length, "a full round shows every passage once");
  // The next round starts with something other than the last one shown.
  assert.notEqual(ref(D.today(day(all.length))), round[round.length - 1]);
  const round2 = Array.from({ length: all.length }, (_, i) => ref(D.today(day(all.length + i))));
  assert.equal(new Set(round2).size, all.length, "the second round is a full round too");
}

// Two installs get different orders (shuffled per person) -- with 35! orders, a clash is a bug.
{
  const a = load().D;
  const b = load().D;
  const seq = (D) => Array.from({ length: 10 }, (_, i) => ref(D.today(day(i)))).join("|");
  assert.notEqual(seq(a), seq(b));
}

// Skipping days carries on through the round instead of restarting; still no repeats in it.
{
  const { D, all } = load();
  const seen = [ref(D.today(day(0))), ref(D.today(day(10))), ref(D.today(day(20))), ref(D.today(day(34)))];
  assert.equal(new Set(seen).size, 4);
  assert.ok(seen.every((r) => all.some((p) => p.reference === r)));
}

// A changed list starts a fresh cycle that day; a clock set backwards does too.
{
  const { D, all } = load();
  D.today(day(5));
  const fewer = load(all.slice(0, 3));
  fewer.meta.daily_passage_cycle = JSON.stringify({ start: D.dayNumber(day(0)), refs: all.map((p) => p.reference) });
  assert.ok(all.slice(0, 3).some((p) => p.reference === ref(fewer.D.today(day(5)))));
  assert.equal(JSON.parse(fewer.meta.daily_passage_cycle).refs.length, 3);
  const back = load();
  back.D.today(day(10));
  assert.ok(back.D.today(day(2)), "a day before the cycle start still gets a passage");
}

// The schedule handed to the notifiers (they offer today's passage while the app is closed): it runs from
// today through the end of the NEXT round, and what it says for a day is what Home shows that day -- even
// across the round boundary, because the next round drawn for the schedule is the one used.
{
  const { D, all } = load();
  D.today(day(0)); // the cycle started three days ago
  const sched = D.schedule(day(3));
  assert.deepEqual(D.schedule(day(3)), sched, "asking again doesn't redraw it");
  assert.equal(sched[0].day, D.dayNumber(day(3)));
  assert.equal(sched.length, 2 * all.length - 3, "rest of this round + all of the next");
  assert.ok(sched.every((s, i) => i === 0 || s.day === sched[i - 1].day + 1), "consecutive days");
  for (const s of sched) {
    const date = new Date(2026, 9, 7 + (s.day - D.dayNumber(day(0))), 12);
    assert.equal(ref(D.today(date)), s.ref, `day ${s.day}`);
  }
  const nextRound = sched.slice(all.length - 3).map((s) => s.ref);
  assert.equal(new Set(nextRound).size, all.length, "the next round is a full round too");
  assert.notEqual(nextRound[0], sched[all.length - 4].ref, "and doesn't open with the last one of this round");
}

// Passages prayed through in the app today (a nudge later today then offers a different one).
{
  const { D } = load();
  const used = (d) => JSON.parse(JSON.stringify(D.usedToday(d))); // out of the vm's realm
  assert.deepEqual(used(day(0)), []);
  D.markUsed("Romans 8:31-39", day(0));
  D.markUsed("Romans 8:31-39", day(0));
  D.markUsed("Psalm 23:1-6", day(0, 22));
  assert.deepEqual(used(day(0)), ["Romans 8:31-39", "Psalm 23:1-6"]);
  assert.deepEqual(used(day(1)), [], "a new day starts clean");
  assert.equal(D.byRef("Romans 8:31-39").description.length > 10, true);
}

console.log("daily passage tests passed");
