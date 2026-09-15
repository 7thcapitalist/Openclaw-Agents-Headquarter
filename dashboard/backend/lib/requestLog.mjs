// Request logging for the Headquarters dashboard.
//
// Why this exists: the dashboard grew as a debugging instrument and now carries
// ~82 routes, of which an audit found roughly 25 with no UI caller and five
// surfaces that render nothing. Deciding what to delete needs evidence of what
// the founder actually opens, and until now the server logged no requests at
// all — "did that call even arrive" was answerable only by reading file mtimes.
//
// Deliberately dependency-free, matching lib/httpSecurity.mjs: morgan/pino-http
// would each add a third-party artifact to factory/third-party/provenance.json
// for behaviour that is a few dozen lines here.
//
// Two consumers:
//   - stdout, so `pm2 logs hq-dashboard` finally shows traffic;
//   - an NDJSON file, so scripts/hq-route-usage.mjs can aggregate it later.
//
// What is NOT recorded, on purpose: request bodies, query-string values, cookies
// and headers. This file is a usage record, not an audit trail — lib/securityAudit.mjs
// is the audit trail. Bodies here would mean approval payloads, objective text and
// the login password landing in a plaintext file that nothing redacts.

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

// Path segments that are identifiers rather than route structure. Logging them
// raw would make every task its own "route" and defeat the aggregation this
// exists for, so they collapse to a placeholder.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TASK_ID = /^(task|obj)-[0-9a-f]{6,}/i;
const LONG_HEX = /^[0-9a-f]{12,}$/i;
const DIGITS = /^\d+$/;

// A path is at most ~8 segments of route structure; anything longer is a file
// path under an agent workspace and is not useful to aggregate segment by segment.
const MAX_SEGMENTS = 8;

export function normalizeRoute(path) {
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return "/";
  const out = [];
  for (const segment of segments.slice(0, MAX_SEGMENTS)) {
    if (UUID.test(segment) || TASK_ID.test(segment) || LONG_HEX.test(segment) || DIGITS.test(segment)) {
      out.push(":id");
    } else {
      out.push(segment);
    }
  }
  if (segments.length > MAX_SEGMENTS) out.push("*");
  return "/" + out.join("/");
}

// Rotate at a fixed size rather than by date: this box has had a /tmp leak and an
// unbounded events array already, and a log nobody prunes is the same bug again.
// One rotation only — two files is enough history to answer "what did I use this
// week" and caps the cost at 2x maxBytes forever.
function rotateIfNeeded(file, maxBytes) {
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    return; // not created yet
  }
  if (size < maxBytes) return;
  try {
    renameSync(file, `${file}.1`);
  } catch {
    // A failed rotation must not take the dashboard down; the file just grows
    // until the next attempt succeeds.
  }
}

/**
 * Express middleware recording one line per completed response.
 *
 * @param {object}  options
 * @param {string}  [options.file]      NDJSON destination. Omit to log to stdout only.
 * @param {boolean} [options.stdout]    Also write a human line to stdout (default true).
 * @param {number}  [options.maxBytes]  Rotate the NDJSON file above this size (default 16 MiB).
 * @param {number}  [options.slowMs]    Mark responses slower than this (default 1000).
 */
export function requestLog({ file = "", stdout = true, maxBytes = 16 * 1024 * 1024, slowMs = 1000 } = {}) {
  if (file) {
    try {
      mkdirSync(dirname(file), { recursive: true });
    } catch {
      // If the directory cannot be made, fall through: the append below fails
      // per-request and is swallowed, and stdout logging still works.
    }
  }

  return function requestLogMiddleware(req, res, next) {
    const startedAt = process.hrtime.bigint();

    // 'finish' fires when the response is flushed; 'close' catches the client
    // hanging up mid-response, which is exactly what the 2.5s execution-modal
    // poller does on navigation and what would otherwise go unrecorded.
    let recorded = false;
    const record = () => {
      if (recorded) return;
      recorded = true;

      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const route = normalizeRoute(req.path);
      const entry = {
        at: new Date().toISOString(),
        method: req.method,
        route,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 10) / 10,
        bytes: Number(res.getHeader("content-length")) || 0,
        // Whether a session was present, not who it was: this box has a single
        // shared password, so the only signal available is authed vs not.
        authed: Boolean(req.session && req.session.authenticated),
        api: req.path.startsWith("/api/"),
        aborted: !res.writableFinished,
      };

      if (file) {
        try {
          rotateIfNeeded(file, maxBytes);
          appendFileSync(file, JSON.stringify(entry) + "\n");
        } catch {
          // Never let logging fail a request.
        }
      }

      if (stdout) {
        const slow = durationMs >= slowMs ? " SLOW" : "";
        const abort = entry.aborted ? " ABORTED" : "";
        console.log(
          `[req] ${entry.method} ${route} ${entry.status} ${entry.durationMs}ms${slow}${abort}`
        );
      }
    };

    res.on("finish", record);
    res.on("close", record);
    next();
  };
}
