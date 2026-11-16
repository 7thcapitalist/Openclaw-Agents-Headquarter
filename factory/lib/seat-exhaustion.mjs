// A model seat that is out of credit, over its session limit, or throttled.
//
// This is not a failure of the work and not something another attempt fixes
// before the provider's window resets. On 2026-09-15 six objectives dispatched
// into exhausted seats ("You've hit your session limit · resets 12:40am", "Auth
// profile ... is temporarily unavailable"); every dispatch that could not start
// was charged as a failed attempt, recovery ran diagnose/verify against the same
// wall three times per task, and all six escalated to the founder as failures
// within an hour. None of them had anything wrong with the work.
//
// So an exhausted seat PAUSES the task until the reset instead of spending any
// budget. Only text the harness produces is ever checked here (a dispatch that
// could not run, or the fan-out's "agent could not run" result) — never a stage
// verdict — so review prose about the product's own rate limiting cannot match.
//
// Pure. Node builtins only.

// Longer waits for credit/session exhaustion, shorter for plain throttling.
export const DEFAULT_SEAT_WAIT_MS = 60 * 60 * 1000;
export const DEFAULT_THROTTLE_WAIT_MS = 5 * 60 * 1000;

// Consecutive paused dispatches, with nothing between them that ran, before the
// pause itself becomes the founder's problem: the seats are not coming back on
// their own (a lapsed plan, a revoked key), and waiting forever is its own way
// of retrying forever.
export const DEFAULT_MAX_CONSECUTIVE_SEAT_PAUSES = 6;

const EXHAUSTED = new RegExp([
  // "You've hit your session limit" (Claude), "You've reached your Codex
  // subscription usage limit" (Codex). Up to three words may sit between
  // "your" and the limit kind; the "hit|reached your" anchor keeps product
  // prose ("usage limit banner renders twice") from matching.
  "(?:hit|reached) your (?:[\\w-]+ ){0,3}(?:session|usage|daily|weekly|monthly) limit",
  "(?:session|usage|daily|weekly|monthly) limit (?:reached|exceeded|hit)",
  "(?:out of|ran out of|no remaining|insufficient) (?:credits?|quota|balance)",
  "credit balance (?:is )?too low",
  "(?:quota|credits?) (?:is |was |has been )?(?:exceeded|exhausted|depleted)",
  "exceeded your current quota",
  "billing (?:hard )?limit",
  "auth profile\\s+\\S+\\s+is temporarily unavailable",
].join("|"), "i");

// Anchored like the rest: a bare "429" or "rate limit" is ordinary prose about
// the product ("the rate limit middleware returns 500 instead of 429").
const THROTTLED = /(?:status|code|http|error)\s*:?\s*429\b|429 too many requests|too many requests|rate.?limit(?:ed\b| (?:reached|exceeded|hit))/i;

/**
 * Is this harness error an exhausted or throttled seat? Returns null when it is
 * not, otherwise `{ kind, resumeAfter }` where resumeAfter is an ISO time taken
 * from the provider's own message when it gives one.
 */
export function detectSeatExhaustion(text, { now = Date.now() } = {}) {
  const str = String(text || "");
  const nowMs = typeof now === "number" ? now : Date.parse(now) || Date.now();
  let kind = null;
  if (EXHAUSTED.test(str)) kind = "exhausted";
  else if (THROTTLED.test(str)) kind = "throttled";
  if (!kind) return null;
  const parsed = parseResetTime(str, { now: nowMs });
  const fallback = nowMs + (kind === "exhausted" ? DEFAULT_SEAT_WAIT_MS : DEFAULT_THROTTLE_WAIT_MS);
  return { kind, resumeAfter: new Date(parsed ?? fallback).toISOString(), fromProvider: parsed != null };
}

// "resets 12:40am (America/Indiana/Indianapolis)", "try again in 15 minutes",
// "retry after 120 seconds", "Retry-After: 120". Returns epoch ms or null.
export function parseResetTime(text, { now = Date.now() } = {}) {
  const str = String(text || "");
  const relative = str.match(/(?:try again|retry)\s+(?:in|after)\s+(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i);
  if (relative) return now + Number(relative[1]) * unitMs(relative[2]);
  const header = str.match(/retry-after:?\s*(\d+)\b/i);
  if (header) return now + Number(header[1]) * 1000;
  const clock = str.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i);
  if (clock && (clock[2] || clock[3])) {
    return wallClockReset(clock[1], clock[2], clock[3], clock[4], now);
  }
  // Codex: "Next reset in 5 hours, Sep 18 at 7:56 PM EDT." The absolute clock
  // is exact; the relative hours are rounded, so prefer the clock.
  const dated = str.match(/\bresets?\b[^\n"]{0,60}?\bat\s+(\d{1,2}):(\d{2})\s*(am|pm)?\s*(?:\(([^)]+)\)|\b([A-Z]{2,4})\b)?/i);
  if (dated) return wallClockReset(dated[1], dated[2], dated[3], dated[4] || zoneFromAbbreviation(dated[5]), now);
  const inHours = str.match(/\bresets?\s+in\s+(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/i);
  if (inHours) return now + Number(inHours[1]) * unitMs(inHours[2]);
  return null;
}

function wallClockReset(hourText, minuteText, meridiem, timeZone, now) {
  let hour = Number(hourText) % (meridiem ? 12 : 24);
  if (meridiem?.toLowerCase() === "pm") hour += 12;
  const minute = Number(minuteText || 0);
  if (hour > 23 || minute > 59) return null;
  return nextWallClock({ hour, minute, timeZone: timeZone?.trim(), now });
}

// Providers print US zone abbreviations; Intl needs IANA names. An unknown
// abbreviation falls through to the host's zone, as an unknown IANA name does.
const ZONE_ABBREVIATIONS = {
  EDT: "America/New_York", EST: "America/New_York",
  CDT: "America/Chicago", CST: "America/Chicago",
  MDT: "America/Denver", MST: "America/Denver",
  PDT: "America/Los_Angeles", PST: "America/Los_Angeles",
  UTC: "UTC", GMT: "UTC",
};

function zoneFromAbbreviation(abbreviation) {
  return abbreviation ? ZONE_ABBREVIATIONS[abbreviation.toUpperCase()] : undefined;
}

/**
 * The provider's own sentence about the exhausted seat, from raw executor
 * output, or null. A harness can exit without writing a result file while the
 * reason sits only in stdout (Codex prints it as a JSON "message"), so the
 * runner lifts this sentence into the failure summary the detector reads.
 */
export function seatExhaustionExcerpt(text) {
  const str = String(text || "");
  const match = EXHAUSTED.exec(str);
  if (!match) return null;
  const boundary = /[\n"]/;
  let start = match.index;
  while (start > 0 && !boundary.test(str[start - 1])) start -= 1;
  let end = match.index + match[0].length;
  while (end < str.length && !boundary.test(str[end]) && end - start < 300) end += 1;
  return str.slice(start, end).trim() || null;
}

function unitMs(unit) {
  const u = unit.toLowerCase();
  if (u.startsWith("h")) return 60 * 60 * 1000;
  if (u.startsWith("m")) return 60 * 1000;
  return 1000;
}

// The next instant after `now` at which the wall clock in `timeZone` reads
// hour:minute. An unknown zone falls back to the host's.
function nextWallClock({ hour, minute, timeZone, now }) {
  let zone = timeZone;
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); }
  catch { zone = undefined; }
  const today = zonedParts(now, zone);
  for (let dayOffset = 0; dayOffset <= 1; dayOffset += 1) {
    const guess = Date.UTC(today.year, today.month - 1, today.day + dayOffset, hour, minute);
    const at = guess - (zonedAsUtc(guess, zone) - guess);
    if (at > now) return at;
  }
  return null;
}

function zonedParts(ms, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { year: +parts.year, month: +parts.month, day: +parts.day, hour: +parts.hour, minute: +parts.minute, second: +parts.second };
}

// The UTC epoch that has the same wall-clock digits `ms` shows in `timeZone`.
function zonedAsUtc(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

// Paused dispatches at the end of the record with no dispatch that ran between.
export function consecutiveSeatPauses(dispatches = []) {
  let count = 0;
  for (let i = dispatches.length - 1; i >= 0; i -= 1) {
    if (!dispatches[i]?.seatExhausted) break;
    count += 1;
  }
  return count;
}
