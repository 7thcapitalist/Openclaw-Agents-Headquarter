# Independent Review — formatDuration(ms) utility

- Task: obj-d1c457f7-implement-format-duration
- Dispatch: obj-d1c457f7-implement-format-duration-reviewer-1
- Reviewer: claude (independent; did not author the change)
- Branch: factory/obj-d1c457f7-implement-format-duration
- Commit reviewed: d4189b5 "feat(factory): add duration formatter"

## Scope of change

Two new files, no other files touched:

- `factory/lib/format-duration.mjs` (40 lines) — exports `formatDuration(ms)`.
- `factory/test/format-duration.test.mjs` (47 lines) — node:test coverage.

`git show --stat d4189b5` confirms only these two files are in the commit.

## Acceptance criteria

| Criterion | Result |
| --- | --- |
| Exports `formatDuration(ms)`, compact two-largest-nonzero-unit output | PASS |
| `"2d 3h"`, `"4h 12m"`, `"5m 3s"`, `"45s"` | PASS (each asserted) |
| `"0s"` for zero or negative input | PASS (`0`, `-1`, `-5h` asserted) |
| Test covers day / hour / minute / second / zero / negative | PASS (all present; plus sub-second and non-finite) |
| `node --test factory/test/format-duration.test.mjs` passes | PASS — 7 tests, 7 pass, 0 fail |

## Correctness / edge cases reviewed

- Non-finite input (`NaN`, `Infinity`, `-Infinity`) → `"0s"` via `Number.isFinite` guard. Covered.
- Sub-second positive input (`999`, `500`) → `"0s"` via `ms < SECOND` guard. Documented design choice; consistent with "two largest nonzero units" (no nonzero unit ≥ 1s).
- Truncation, not rounding: `4h 12m 59s` → `"4h 12m"`. Matches the AC example `2d 3h` for a span that also contains minutes/seconds. Documented.
- Unit gaps: `1d 30s` → `"1d 30s"` (hours and minutes zero). This is the literal reading of "two largest *nonzero* units" and is documented in the module header. Non-blocking.
- Dependency-free: imports are `node:test` / `node:assert/strict` in the test and nothing in the lib. Complies with the engine's Node-builtins-only constraint.
- Module conventions match existing `factory/test/*.mjs` (`import test from "node:test"`, `import assert from "node:assert/strict"`, relative `../lib/` import).

## Findings

### NON-BLOCKING

1. `return parts.length > 0 ? parts.join(" ") : "0s";` — the `: "0s"` branch is unreachable given the `ms < SECOND` early return (any finite `ms >= 1000` produces at least a seconds part). Harmless defensive code; safe to leave.
2. `1d 30s`-style output (skipping zero intermediate units) is spec-compliant but can surprise a casual reader. Already documented in the header comment; no change required for this task.

No BLOCKING findings. No security, privacy, data-loss, migration, or scope-expansion concerns.

## Verdict

APPROVE

## Evidence

- `docs/software-factory/handoffs/2026-09-07-format-duration-reviewer.md` (this file)
- `node --test factory/test/format-duration.test.mjs` → 7/7 pass (re-run during review)
