# Lessons Learned

Narrative lessons the OpenClaw factory has learned from completed work — both
failures and successes. Maintained by the Learning / R&D Agent; entries are
promoted by the founder via a `learning/*` PR.

Newest entries are appended at the end. Do not delete an entry; if a lesson is
superseded, add a new entry and mark the old one `Status: superseded`.

See `README.md` for the entry format and the memory-tier rules.

<!-- Learning Agent appends entries below this line. -->

## LL-2026-001 — Builder failed on backend task (ambiguous acceptance criteria)

- Date: 2026-09-03
- Scope: global
- Source findings: L-0001
- Confidence: medium
- Evidence tasks: issue-42, issue-51
- Status: proposed

**Observation:** Task issue-42 recorded 1 builder failure(s); classified cause: ambiguous-acceptance-criteria.

**Recommendation:** Require the product stage to emit explicit, executable acceptance tests before the architect stage. Add an acceptance-tests-present check to requiredGates.
