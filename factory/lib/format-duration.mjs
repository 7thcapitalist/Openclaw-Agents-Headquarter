// Compact, human-readable formatter for an elapsed-time span in milliseconds.
//
// Renders the two largest nonzero units drawn from days, hours, minutes, and
// seconds, e.g. "2d 3h", "4h 12m", "5m 3s", "45s". Zero, negative, and
// non-finite input collapse to "0s". Sub-second positive spans floor to "0s".
//
// Intended for test output and future shared use in the factory. There is no
// localization, pluralization, or unit beyond d/h/m/s by design.
//
// Pure. Node builtins only.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const UNITS = [
  ["d", DAY],
  ["h", HOUR],
  ["m", MINUTE],
  ["s", SECOND],
];

// ms: number of milliseconds elapsed. Returns a string such as "2d 3h" or "0s".
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < SECOND) return "0s";

  let remaining = Math.floor(ms);
  const parts = [];
  for (const [label, size] of UNITS) {
    const value = Math.floor(remaining / size);
    if (value > 0) {
      parts.push(`${value}${label}`);
      remaining -= value * size;
    }
    if (parts.length === 2) break;
  }

  return parts.length > 0 ? parts.join(" ") : "0s";
}
