// Parse the provider usage windows printed by `openclaw models status`.
//
// This is shared with the factory doctor so headroom consumers do not grow a
// second, subtly different copy of the provider-output parsing.

export function parseUsageWindow(modelsOut) {
  const output = String(modelsOut || "");
  const short = output.match(/5h\s+(\d+)%\s+left(?:\s+⏱\s*([^\n·]+))?/i);
  const week = output.match(/Week\s+(\d+)%\s+left(?:\s+⏱\s*([^\n·]+))?/i);

  return {
    shortWindow: short
      ? { percentLeft: Number(short[1]), resetIn: short[2]?.trim() || null }
      : null,
    weekWindow: week
      ? { percentLeft: Number(week[1]), resetIn: week[2]?.trim() || null }
      : null,
  };
}

// ── Anthropic seat: `claude -p "/usage"` ─────────────────────────────────────
//
// Claude Code prints human text, not an API, e.g.
//   Current session: 25% used · resets Sep 18, 6:30pm (America/Indiana/Indianapolis)
//   Current week (all models): 72% used · resets Sep 21, 5pm (America/Indiana/Indianapolis)
// Parsing is strict on purpose: anything that does not match yields null
// windows, which every consumer reports as unknown, never as available.

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const USAGE_TAIL = String.raw`:\s*(\d{1,3})% used(?:\s+·\s+resets\s+([A-Za-z]{3}) (\d{1,2}), (\d{1,2})(?::(\d{2}))?(am|pm)\s+\(([A-Za-z_]+(?:\/[A-Za-z_+\-0-9]+)*)\))?\s*$`;
const SESSION_LINE = new RegExp(`^Current session${USAGE_TAIL}`, "im");
const WEEK_LINE = new RegExp(`^Current week \\(all models\\)${USAGE_TAIL}`, "im");

function zoneParts(instantMs, zone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23",
    year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
  }).formatToParts(new Date(instantMs));
  const get = (type) => Number(parts.find((part) => part.type === type).value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

function zoneWallToInstant(year, month, day, hour, minute, zone) {
  const wall = Date.UTC(year, month, day, hour, minute);
  let instant = wall;
  for (let i = 0; i < 2; i += 1) {
    const p = zoneParts(instant, zone);
    instant += wall - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  }
  const check = zoneParts(instant, zone);
  return Date.UTC(check.year, check.month - 1, check.day, check.hour, check.minute) === wall ? instant : null;
}

function formatDuration(ms) {
  const minutes = Math.floor(ms / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days >= 1) return `${days}d ${hours}h`;
  if (hours >= 1) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

function resetIn(match, nowMs) {
  const [, , mon, dayText, hourText, minuteText, meridiem, zone] = match;
  const month = MONTHS.indexOf(String(mon || "").toLowerCase());
  const hour12 = Number(hourText);
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  if (month < 0 || !zone || hour12 < 1 || hour12 > 12 || minute > 59) return null;
  const hour = (hour12 % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0);
  try {
    const year = zoneParts(nowMs, zone).year;
    let instant = zoneWallToInstant(year, month, Number(dayText), hour, minute, zone);
    // The printed reset has no year: a date well in the past means next year.
    if (instant !== null && instant < nowMs - 24 * 3600 * 1000) {
      instant = zoneWallToInstant(year + 1, month, Number(dayText), hour, minute, zone);
    }
    if (instant === null || instant < nowMs) return null;
    return formatDuration(instant - nowMs);
  } catch {
    return null;
  }
}

function claudeWindow(regex, text, nowMs) {
  const match = text.match(regex);
  if (!match) return null;
  const used = Number(match[1]);
  if (!Number.isInteger(used) || used < 0 || used > 100) return null;
  return { percentLeft: 100 - used, resetIn: match[2] ? resetIn(match, nowMs) : null };
}

export function parseClaudeUsage(usageOut, { now = Date.now() } = {}) {
  const text = String(usageOut || "");
  const nowMs = typeof now === "number" ? now : Date.parse(now);
  const safeNow = Number.isFinite(nowMs) ? nowMs : Date.now();
  return {
    shortWindow: claudeWindow(SESSION_LINE, text, safeNow),
    weekWindow: claudeWindow(WEEK_LINE, text, safeNow),
  };
}
