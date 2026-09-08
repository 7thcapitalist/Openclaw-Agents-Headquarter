# Product handoff — intake decision advisory

## Problem
Natural-language intake already produces validated task contracts, but it does not yet surface founder-sensitive classification information before dispatch. The factory needs that signal early so decision-request work is visible without changing the dispatch engine.

## Desired outcome
After intake validation, the contract carries an advisory classification from `factory/lib/intel/classify.mjs` using `factory/decision-protocol.json`, and that advisory result is visible before dispatch while ordinary reversible work continues through the existing path.

## Scope
### In
- Run `classifyDecision()` only after a task contract is produced and validated.
- Pass the objective text, contract `risk`, contract `workType`, and the loaded decision protocol into classification.
- Attach the classification result and matched rule to the contract through an allowed advisory field only.
- Surface advisory decision-request information before dispatch without preventing dispatch.
- Keep ordinary reversible work unflagged.
- Add intake tests for every decision-protocol trigger family plus a reversible-work case.

### Out
- No schema changes to task, request, or result JSON.
- No change to `writeHandoff()`.
- No duplicate classifier or protocol rules.
- No workflow-engine changes.
- No attempt to make advisory classification itself block dispatch.

## Acceptance criteria
- `classifyDecision()` receives objective text, contract `risk`, contract `workType`, and the loaded protocol after contract validation.
- A `decision-request` outcome attaches the classification result and matched rule to the contract through an explicit advisory field.
- Advisory classification is visible before dispatch and does not stop dispatch.
- Ordinary reversible work remains unflagged and follows the current dispatch path unchanged.
- Intake tests cover privacy, spend, public, product-direction, scope, irreversible, security-posture, legal, high-risk, blocking clarification, and reversible-work cases.
- The existing factory test suite remains green.

## Non-goals
- Reworking the 7-stage state machine.
- Changing the meaning of engine-owned `blocked` states.
- Introducing new founder decision types beyond the existing protocol.
- Changing the contract schema or result file schema.

## Open strategic decisions
- The task text asks for `decision-request` and `block` outcomes to be attached as advisory information. The current protocol and classifier only define `continue`, `decision-request`, and `ask`, while `block` is explicitly owned by the workflow engine. Decide whether the implementation should keep `block` out of the intake advisory layer and treat only `decision-request` / `ask` as intake advisories, or expand the advisory contract to represent engine-owned `blocked` states in a separate, clearly named field.

## Verification expected
- Run the intake/classifier test coverage for all trigger families and the reversible-work case.
- Run the full factory test suite to confirm no regression.
