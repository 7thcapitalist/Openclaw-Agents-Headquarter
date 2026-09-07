Acceptance criteria: PASS  

All acceptance criteria were independently verified by running `node --test factory/test/format-duration.test.mjs` in the isolated worktree. The focused node:test suite passes all 7 tests, covering all required output cases:

- Day-scale (two largest nonzero units, e.g. "2d 3h")
- Hour-scale (e.g. "4h 12m")
- Minute-scale (e.g. "5m 3s")
- Second-scale (e.g. "45s")
- Zero, negative, sub-second, and non-finite input (all collapse to "0s")

The implementation never emits unwanted extra units, does not pluralize, and is dependency-free. The code test suite directly asserts every product acceptance example and edge case, and test log evidence is included.

Scenarios tested:
- All acceptance-criteria value cases via node:test file
- Large, small, negative, zero, sub-second, and non-finite input

No bugs were found. No missing output, regression, or spec gap observed.

Final verdict: QA PASS
