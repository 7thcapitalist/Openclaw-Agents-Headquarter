// Never operate on a durable file whose format you do not understand.
//
// Adapted from the discipline underneath Paperclip's migration-safety tooling
// (`packages/db/src/check-migration-safety.ts`) at pinned commit
// 6abeb67334348dcb6fde2d591a27ffc7efc7118d (MIT). Issue #159.
//
// Upstream runs static safety rules over 270 SQL migrations and asserts the
// declared schema and the applied migrations agree. HQ has no SQL migrations,
// so the scanner is not the transferable part. The rule underneath it is.
//
// WHAT WAS ACTUALLY TRUE HERE. Every HQ durable artifact carries `version: 1`.
// Some readers check it — the wakeup queue, leases, cost events, audit events
// and interactions all compare against 1 — and they do it five different ways,
// none of which names the file, the version found, or the version supported.
// The registries (goals, budgets, permissions) and canonical task and objective
// state do not check at all: they read `parsed.version` past and return their
// own `version: 1`, so a `version: 2` file written by a newer HQ is parsed by
// an older one and silently misread. #145 added a SQLite state authority whose
// format will change, which makes that a matter of time rather than taste.
//
// WHAT THIS REFUSES. A version ABOVE what the code understands — a file from
// the future. A version at or below is read exactly as it is read today, so
// installing this changes no behaviour for any file that exists now.
//
// A MISSING VERSION IS THE FLOOR, not an error. Operator-authored registry
// files omit it today and are accepted today; refusing them would turn a
// hardening change into an outage on the operator's own config.
//
// THE REFUSAL IS TYPED so a projection can degrade on it. Reading a file from
// the future must show the operator "this file is newer than this HQ", not take
// the factory down and not — far worse — render a confidently wrong projection.

// Every durable format HQ persists, and the highest version this code can read.
//
// This registry is the enumeration `durable-versions.test.mjs` walks. A format
// added here without a reader that performs the check fails that test, which is
// the only thing that keeps the rule from decaying one new file at a time.
export const DURABLE_FORMATS = Object.freeze({
  "task-state": { max: 1, kind: "json", describe: "canonical task state" },
  "objective-state": { max: 1, kind: "json", describe: "canonical objective state" },
  "wakeup-queue": { max: 1, kind: "json", describe: "durable wakeup queue" },
  "task-lease": { max: 1, kind: "json", describe: "task execution lease" },
  "goal-registry": { max: 1, kind: "json", describe: "tracked goal registry" },
  "budget-registry": { max: 1, kind: "json", describe: "budget policy registry" },
  "permission-registry": { max: 1, kind: "json", describe: "permission grant registry" },
  "connector-state": { max: 1, kind: "json", describe: "connector cursor and circuit state" },
  "audit-event": { max: 1, kind: "ndjson", describe: "audit ledger" },
  "cost-event": { max: 1, kind: "ndjson", describe: "cost ledger" },
  "interaction": { max: 1, kind: "ndjson", describe: "task interaction thread" },
  "connector-event": { max: 1, kind: "ndjson", describe: "connector outbox" },
});

// A distinct type, so a projection can tell "this file is from the future" —
// which it should report and survive — from "this file is corrupt".
export class UnsupportedVersionError extends Error {
  constructor({ format, path, found, max }) {
    super(
      `${DURABLE_FORMATS[format]?.describe || format} at ${path} is version ${found}, ` +
      `but this HQ understands version ${max} at most. Upgrade HQ, or restore a version ${max} file. ` +
      `Refusing to read it rather than misinterpret it.`,
    );
    this.name = "UnsupportedVersionError";
    this.code = "ERR_DURABLE_VERSION_UNSUPPORTED";
    this.format = format;
    this.path = path;
    this.found = found;
    this.max = max;
  }
}

export function supportedVersion(format) {
  const entry = DURABLE_FORMATS[format];
  if (!entry) throw new Error(`Unknown durable format '${format}'`);
  return entry.max;
}

// The whole check, in one place.
//
//   absent        -> the floor (1). Exactly today's behaviour.
//   1..max        -> accepted, returned as a number.
//   above max     -> UnsupportedVersionError.
//   anything else -> a malformed file, which is not this module's problem to
//                    interpret, so it is reported as one.
export function assertSupportedVersion(value, { format, path, max = null }) {
  const ceiling = max ?? supportedVersion(format);
  if (value === undefined || value === null) return 1;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${DURABLE_FORMATS[format]?.describe || format} at ${path} has an invalid version: ${JSON.stringify(value)}`);
  }
  if (value > ceiling) throw new UnsupportedVersionError({ format, path, found: value, max: ceiling });
  return value;
}

// True when an error means "this file is from the future" — the signal a
// projection should surface as a warning rather than treat as a crash.
export function isUnsupportedVersion(error) {
  return error?.code === "ERR_DURABLE_VERSION_UNSUPPORTED";
}
