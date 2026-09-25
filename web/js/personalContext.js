// Turns this person's own check-ins into a few plain sentences the on-device AI can use gently. Qualitative on purpose: small models tend to recite exact numbers back.
const DAY_MS = 86400000;

function describeTimeOfDay(date) {
  const h = date.getHours();
  const part = h >= 5 && h < 12 ? "morning" : h >= 12 && h < 17 ? "afternoon" : h >= 17 && h < 21 ? "evening" : "late at night";
  return `${date.toLocaleDateString("en-US", { weekday: "long" })}, ${part}`;
}

// Calendar days, so a slip at 11pm last night reads as "yesterday" the next evening.
function daysAgo(timestamp, now) {
  const start = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((start(now) - start(new Date(timestamp))) / DAY_MS);
}

function describeAgo(days) {
  if (days < 1) return "earlier today";
  if (days < 2) return "yesterday";
  if (days < 6) return "a few days ago";
  if (days < 11) return "about a week ago";
  if (days < 25) return "a couple of weeks ago";
  return "over a month ago";
}

function isLateNight(date) {
  const h = date.getHours();
  return h >= 21 || h < 5;
}

function buildPersonalContext(checkins, now = new Date()) {
  if (!checkins.length) return "";
  const parts = [];
  const recent = checkins.filter((c) => now - new Date(c.timestamp) <= 30 * DAY_MS);
  const slips = recent.filter((c) => c.type === "slipped");

  if (recent.length) {
    const strong = recent.length - slips.length;
    const trend =
      !slips.length ? "and have stayed strong every time" : strong > slips.length * 2 ? "and have mostly stayed strong" : strong >= slips.length ? "with a mix of strong days and slips" : "and have been slipping more often than not";
    parts.push(`They have checked in ${recent.length >= 8 ? "often" : "a few times"} this past month ${trend}.`);
  }

  const lastSlip = checkins.find((c) => c.type === "slipped");
  if (lastSlip) parts.push(`Their last slip was ${describeAgo(daysAgo(lastSlip.timestamp, now))}.`);

  const counts = {};
  for (const c of slips.length >= 2 ? slips : recent) for (const t of c.tags || []) if (t !== "Other") counts[t] = (counts[t] || 0) + 1;
  const top = Object.entries(counts)
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([t]) => t.toLowerCase());
  if (top.length) parts.push(`Situations they often mark: ${top.join(", ")}.`);

  if (slips.length >= 2 && slips.filter((c) => isLateNight(new Date(c.timestamp))).length / slips.length >= 0.6) {
    parts.push("Most of their slips happen late at night.");
  }

  const latest = checkins[0];
  const latestDays = daysAgo(latest.timestamp, now);
  if (latestDays <= 7) {
    let s = `Their latest check-in, ${describeAgo(latestDays)}, was "${latest.type === "slipped" ? "slipped" : "stayed strong"}"`;
    if (latest.tags && latest.tags.length) s += `, marked ${latest.tags.map((t) => t.toLowerCase()).join(", ")}`;
    if (latest.notes && latest.notes.trim()) s += `, with the note "${latest.notes.trim().replace(/\s+/g, " ").slice(0, 160)}"`;
    parts.push(s + ".");
  }
  return parts.join(" ");
}

// Turns their own onboarding/preferences answers (UserPreferencesStore) into a few plain
// sentences too — same reasoning as buildPersonalContext above, and deliberately generated fresh
// from the stored structured answers rather than a separately-maintained file, so it can never
// drift out of sync with what they actually entered in Privacy.
function buildUserPreferencesContext(prefs) {
  if (!prefs) return "";
  const parts = [];

  if (prefs.accountability_name) {
    parts.push(`Their accountability partner is ${prefs.accountability_name}${prefs.accountability_phone ? " — reachable directly from the app" : ""}.`);
  }
  if (prefs.pastor_name) {
    parts.push(`Their pastor/mentor is ${prefs.pastor_name}.`);
  }
  if (prefs.tempting_times && prefs.tempting_times.length) {
    parts.push(`They say they're most tempted in the ${prefs.tempting_times.join(", ").toLowerCase()}.`);
  }
  if (prefs.common_triggers && prefs.common_triggers.length) {
    parts.push(`Situations they've flagged as hardest: ${prefs.common_triggers.map((t) => t.toLowerCase()).join(", ")}.`);
  }
  if (prefs.tempting_locations && prefs.tempting_locations.trim()) {
    parts.push(`Where it tends to happen: ${prefs.tempting_locations.trim()}.`);
  }
  if (prefs.other_notes && prefs.other_notes.trim()) {
    parts.push(`In their own words about what to know: "${prefs.other_notes.trim().replace(/\s+/g, " ").slice(0, 200)}"`);
  }
  return parts.join(" ");
}
