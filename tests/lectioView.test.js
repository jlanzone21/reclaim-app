// Run: node tests/lectioView.test.js
// The Lectio Divina meditation's phrase splitting (web/js/lectioView.js): in step 1 the person taps "the word
// or phrase that catches your attention", so each verse is cut into tappable phrases after sentence and clause
// punctuation -- but not at commas, which would leave fragments too small to sit with. (Parsing YouVersion's
// HTML needs a DOM and was checked in the browser against real passages.)
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "web", "js", "lectioView.js"), "utf8") + "\n;this.LectioView = LectioView;", sandbox);
const phrases = (t) => JSON.parse(JSON.stringify(sandbox.LectioView._phrasesOf(t)));

// Romans 8:31 (NIV): two sentences, the second keeps its comma.
assert.deepEqual(phrases("What, then, shall we say in response to these things? If God is for us, who can be against us?"), [
  "What, then, shall we say in response to these things?",
  "If God is for us, who can be against us?",
]);
// Romans 8:32: split at the em dash, which stays with the first half.
assert.deepEqual(phrases("He who did not spare his own Son, but gave him up for us all—how will he not also, along with him, graciously give us all things?"), [
  "He who did not spare his own Son, but gave him up for us all—",
  "how will he not also, along with him, graciously give us all things?",
]);
// John 10:27-30: semicolons, and a closing quotation mark stays with its sentence.
assert.deepEqual(phrases("My sheep listen to my voice; I know them, and they follow me."), ["My sheep listen to my voice;", "I know them, and they follow me."]);
assert.deepEqual(phrases("I and the Father are one.”"), ["I and the Father are one.”"]);
// No closing punctuation (a verse that runs on into the next line), and a verse with none at all.
assert.deepEqual(phrases("He makes me lie down in green pastures, he leads me beside quiet waters,"), ["He makes me lie down in green pastures, he leads me beside quiet waters,"]);
assert.deepEqual(phrases("Be still"), ["Be still"]);

console.log("lectio view tests passed");
