# Independent Review (pass 2) — formatDuration(ms) utility

- Task: obj-d1c457f7-implement-format-duration
- Dispatch: obj-d1c457f7-implement-format-duration-reviewer-2
- Reviewer: claude (independent; did not author the change)
- Branch: factory/obj-d1c457f7-implement-format-duration
- Commit reviewed: d4189b5 "feat(factory): add duration formatter"

## Scope

`git diff main...HEAD --stat` shows exactly two new files, nothing else:

- `factory/lib/format-duration.mjs` (+40)
- `factory/test/format-duration.test.mjs` (+47)

`git diff main...HEAD --check` passes (no whitespace errors). Working tree
has no staged/modified tracked files; untracked items are factory scratch
artifacts (handoffs, evidence, qa logs), not part of the change.

## Acceptance criteria

| Criterion | Result |
| --- | --- |
| `format-duration.mjs` exports `formatDuration(ms)`, two-largest-nonzero-unit compact output | PASS |
| Required examples `2d 3h`, `4h 12m`, `5m 3s`, `45s` | PASS — each asserted and re-verified |
| `0s` for zero or negative input | PASS — `0`, `-1`, `-5h` asserted |
| Test covers day / hour / minute / second / zero / negative | PASS — all present (plus sub-second and non-finite) |
| `node --test factory/test/format-duration.test.mjs` passes | PASS — tests 7, pass 7, fail 0 |

## Correctness / edge cases

- `Number.isFinite` guard maps `NaN`, `Infinity`, `-Infinity`, `undefined`,
  non-numeric input to `"0s"`. Covered by tests for `NaN` / `Infinity`.
- `ms < SECOND` early return folds sub-second positive spans (`999`, `500`)
  to `"0s"`. Intentional and documented in the module header.
- `Math.floor(ms)` truncates fractional milliseconds; larger units truncate
  rather than round (`4h 12m 59s` -> `"4h 12m"`), consistent with the
  `2d 3h` acceptance example which also drops lower units.
- "Two largest nonzero units" is implemented literally: zero intermediate
  units are skipped, so `1d 30s` -> `"1d 30s"`. Faithful to the AC wording,
  documented in the header, and explicitly asserted in the test.
- No unbounded loop: `UNITS` has 4 entries and the loop breaks at 2 parts.
- Dependency-free: lib imports nothing; test imports only `node:test` and
  `node:assert/strict`. Complies with the engine Node-builtins-only rule.
- Style matches existing `factory/test/*.test.mjs` (same import idioms,
  relative `../lib/` import, `assert.equal`).

## Regression / risk

- Additive only; no existing module imports the new file. Full factory suite
  re-run via `npm run test:factory` glob: tests 235, pass 235, fail 0.
- No security, privacy, secret-handling, data-loss, or migration surface.
- No scope expansion beyond the two permitted files.

## Findings

### NON-BLOCKING

1. The `: "0s"` fallback in `return parts.length > 0 ? parts.join(" ") : "0s"`
   is unreachable once the `ms < SECOND` guard has passed (any finite
   `ms >= 1000` yields at least a seconds part). Harmless dead-safe branch.
2. `1d 30s`-style non-contiguous output is spec-compliant but can surprise a
   casual consumer. Already called out in the header comment; no change
   required for this task.

No BLOCKING findings.

## Verdict

APPROVE

## Evidence

- `docs/software-factory/handoffs/2026-09-07-format-duration-reviewer-2.md` (this file)
- `node --test factory/test/format-duration.test.mjs` -> 7/7 pass (re-run)
- `npm run test:factory` -> 235/235 pass (re-run)
