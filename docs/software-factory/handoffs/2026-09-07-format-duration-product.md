# Product handoff — `formatDuration(ms)`

## Problem
The factory needs a small, dependency-free duration formatter that renders elapsed milliseconds in a compact human-readable form for tests and future shared use.

## Desired outcome
`factory/lib/format-duration.mjs` exports `formatDuration(ms)` and returns a stable compact string using the two largest nonzero units, with `0s` for zero or negative input.

## Scope
### In
- Add `formatDuration(ms)` as a standalone module in `factory/lib/format-duration.mjs`.
- Add `node:test` coverage in `factory/test/format-duration.test.mjs`.
- Verify the formatter handles day, hour, minute, second, zero, and negative inputs.

### Out
- No callsite refactors.
- No workflow-engine changes.
- No localization, pluralization framework, or extra units beyond days, hours, minutes, and seconds.

## Acceptance criteria
- `formatDuration(2 * 24 * 60 * 60 * 1000 + 3 * 60 * 60 * 1000)` returns `2d 3h`.
- `formatDuration(4 * 60 * 60 * 1000 + 12 * 60 * 1000)` returns `4h 12m`.
- `formatDuration(5 * 60 * 1000 + 3 * 1000)` returns `5m 3s`.
- `formatDuration(45 * 1000)` returns `45s`.
- `formatDuration(0)` and any negative input return `0s`.
- `node --test factory/test/format-duration.test.mjs` passes.

## Verification expected
- Run `node --test factory/test/format-duration.test.mjs`.

## Open strategic decisions
- None. The behavior is fully specified by the task contract and the examples above.
