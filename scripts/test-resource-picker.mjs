// Offline checks for the AI agent's resource picking (web/js/resourcePicker.js) -- no browser, no
// model. Loads the real agentTools.js / resourceFeedback.js / resourcePicker.js into one vm context
// (they're classic scripts sharing globals, exactly like index.html), with a tiny stub for the parts
// that need the database. Run: npm run test:picker
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "js");
const ctx = vm.createContext({
  console,
  // Only hasTheme is used by the picker. Local content tagged with each theme (by type), as a
  // stand-in for the seeded resources table.
  ResourceRepo: {
    hasTheme: (type, theme) =>
      ({ devotional: ["shame", "temptation", "hope", "loneliness", "grace"], coping_mechanism: ["anxiety", "stress", "in-the-moment"] }[type] || []).includes(theme),
  },
});
for (const file of ["agentTools.js", "resourceFeedback.js", "resourcePicker.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), ctx, { filename: file });
}
const picker = vm.runInContext("ResourcePicker", ctx);
// Copy results out of the vm's realm: its arrays have a different prototype, which deepStrictEqual rejects.
const pick = (...args) => JSON.parse(JSON.stringify(picker.pick(...args)));
const ranker = (...args) => (rows) => [...picker.ranker(...args)(rows)];

// Profiles in ResourceFeedback.profile()'s shape: { tools: { name: { score } }, keywords: {...} }.
const profile = (tools = {}, keywords = {}) => ({
  tools: Object.fromEntries(Object.entries(tools).map(([k, score]) => [k, { score }])),
  keywords: Object.fromEntries(Object.entries(keywords).map(([k, score]) => [k, { score }])),
});
const names = (picks) => picks.map((p) => p.resource);
const items = (picks) => picks.reduce((n, p) => n + p.limit, 0);
// The picker adds a little randomness; run each case many times and check what must always hold.
const many = (fn, n = 300) => Array.from({ length: n }, fn);

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

test("small talk and questions about the AI get no cards", () => {
  assert.deepEqual(pick("hey, how's it going?"), []);
  assert.deepEqual(pick("are you a counselor?"), []);
  assert.deepEqual(pick("are you lonely too?"), []);
});

test("cold start: a feeling gets the mapped kinds, verse first", () => {
  for (const p of many(() => pick("I feel so lonely tonight"))) {
    assert.equal(p[0].resource, "scripture_search");
    assert.equal(p[0].theme, "loneliness");
    assert.ok(names(p).includes("small_group_finder"), names(p).join());
  }
});

test("cold start: an urge gets coping tools plus a verse", () => {
  for (const p of many(() => pick("I'm about to look, I need something to do instead"))) {
    assert.equal(p[0].resource, "coping_toolkit");
    assert.equal(p[0].theme, "in-the-moment");
    assert.equal(p[0].explicit, true);
    const verse = p.find((x) => x.resource === "scripture_search");
    assert.ok(verse, names(p).join());
    assert.equal(verse.theme, "temptation"); // not an unrelated Today's Verse
  }
});

test("a verse asked for with no feeling stays Today's Verse", () => {
  assert.equal(pick("can you share a verse")[0].theme, null);
});

test("never more than 3 kinds or 4 items, and at most 2 of a kind", () => {
  const msgs = [
    "I feel ashamed and lonely, can you find me a verse, a sermon, a counselor and a group",
    "I'm stressed, I need coping tools and a bible plan and articles",
    "I relapsed again",
  ];
  const liked = profile({ devotional_finder: 0.9, small_group_finder: 0.9, bible_plan_finder: 0.9, article_finder: 0.9 });
  for (const m of msgs) {
    for (const p of many(() => pick(m, "", { profile: liked }), 100)) {
      assert.ok(p.length <= 3, `${m}: ${names(p)}`);
      assert.ok(items(p) <= 4, `${m}: ${items(p)} items`);
      assert.ok(p.every((x) => x.limit >= 1 && x.limit <= 2));
      assert.equal(new Set(names(p)).size, p.length);
    }
  }
});

test("explicit asks are honored even when strongly disliked", () => {
  const hates = profile({ counseling_directory: -1, small_group_finder: -1 });
  for (const p of many(() => pick("can you find me a counselor", "", { profile: hates }))) {
    assert.equal(p[0].resource, "counseling_directory");
    assert.equal(p[0].explicit, true);
  }
  for (const p of many(() => pick("find me a recovery group", "", { profile: hates }))) {
    assert.ok(names(p).includes("small_group_finder"));
  }
});

test("a disliked kind stops being added unasked", () => {
  const noGroups = profile({ small_group_finder: -0.5 });
  for (const p of many(() => pick("I feel so lonely tonight", "", { profile: noGroups }))) {
    assert.ok(!names(p).includes("small_group_finder"), names(p).join());
  }
});

test("a disliked default primary gives way to a liked fitting kind", () => {
  const prefersDevotionals = profile({ scripture_search: -0.6, devotional_finder: 0.6 });
  for (const p of many(() => pick("I feel so much shame", "", { profile: prefersDevotionals }))) {
    assert.equal(p[0].resource, "devotional_finder", names(p).join());
  }
});

test("liked kinds are added only when they fit the theme", () => {
  const likesSermons = profile({ sermon_library: 1, devotional_finder: 0.6 });
  for (const p of many(() => pick("I feel so much shame", "", { profile: likesSermons }))) {
    assert.ok(!names(p).includes("sermon_library"), "sermons have no shame content and aren't mapped");
    assert.ok(names(p).includes("devotional_finder"));
  }
});

test("an explicit ask with no feeling adds only a clearly liked kind", () => {
  for (const p of many(() => pick("find me a sermon"))) assert.deepEqual(names(p), ["sermon_library"]);
  const oneThumb = profile({ devotional_finder: 0.33 });
  for (const p of many(() => pick("find me a sermon", "", { profile: oneThumb }))) assert.deepEqual(names(p), ["sermon_library"]);
  const clearlyLiked = profile({ devotional_finder: 0.6 });
  for (const p of many(() => pick("find me a sermon", "", { profile: clearlyLiked }))) {
    assert.deepEqual(names(p), ["sermon_library", "devotional_finder"]);
  }
});

test("the accountability partner is never added unasked, always shown when asked, never trimmed", () => {
  const loves = profile({ accountability_match: 1 });
  for (const p of many(() => pick("I feel so lonely tonight", "", { profile: loves }))) {
    assert.ok(!names(p).includes("accountability_match"));
  }
  const hates = profile({ accountability_match: -1 });
  for (const p of many(() => pick("I need my accountability partner, and a verse and a group and coping tools", "", { profile: hates }))) {
    const a = p.find((x) => x.resource === "accountability_match");
    assert.ok(a, names(p).join());
    assert.equal(a.limit, 2);
  }
});

test("onboarding's preferred method nudges which kinds come along", () => {
  // Stress maps to coping, devotional, verse; the verse is 3rd (0.55) and only clears the bar with the bonus.
  const without = many(() => names(pick("I'm so stressed")).includes("scripture_search")).filter(Boolean).length;
  const withPref = many(() => names(pick("I'm so stressed", "", { preferredMethods: ["Scripture"] })).includes("scripture_search")).filter(Boolean).length;
  assert.ok(withPref > without, `${withPref} vs ${without}`);
});

test("a short yes answers the previous reply", () => {
  const p = pick("yes please", "I found a verse about grace.");
  assert.equal(p[0].resource, "scripture_search");
});

test("ranker: theme match outranks liked keywords; liked keywords decide among on-topic items", () => {
  const rows = [
    { title: "Off-topic but liked", tags: ["hope", "breathing"] },
    { title: "On-topic, disliked keyword", tags: ["shame", "journaling"] },
    { title: "On-topic, liked keyword", tags: ["shame", "breathing"] },
  ];
  const p = profile({}, { breathing: 0.8, journaling: -0.8 });
  for (const order of many(() => ranker("coping_toolkit", "shame", p)(rows).map((r) => r.title))) {
    assert.deepEqual(order, ["On-topic, liked keyword", "On-topic, disliked keyword", "Off-topic but liked"]);
  }
});

test("ranker: derived keywords work for Supabase rows, and distance still matters", () => {
  const groups = [
    { id: 1, title: "Far liked", subtitle: "Pure Desire Ministries", distanceMeters: 1609.34 * 400 },
    { id: 2, title: "Near disliked", subtitle: "Every Man's Battle", distanceMeters: 1609.34 * 5 },
    { id: 3, title: "Near liked", subtitle: "Pure Desire Ministries", distanceMeters: 1609.34 * 10 },
  ];
  const p = profile({}, { "pure desire ministries": 0.8, "every man's battle": -0.8 });
  for (const order of many(() => ranker("small_group_finder", null, p)(groups).map((r) => r.title))) {
    assert.deepEqual(order, ["Near liked", "Near disliked", "Far liked"]);
  }
});

console.log(`\n${passed} passed`);
