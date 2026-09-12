# Product handoff — `handoff company context`

## Problem
Stage handoffs still inject only the factory/project context pack. The company-context layer exists, but it is not yet wired into `factory/lib/handoff.mjs`, so agents do not see the company-level mission, project-specific roll-up, or redacted company signals before the existing context pack.

## Desired outcome
Every generated handoff starts with the project-scoped company-context block from `assembleAgentContext()`, followed by the existing factory/project context pack, while preserving the current `writeHandoff()` signature and the existing try/catch degradation behavior.

## Scope
### In
- Update `factory/lib/handoff.mjs` to call `assembleAgentContext()` instead of `assembleContextPack()`.
- Pass `companyState` through the existing options object without changing `writeHandoff()`'s signature.
- Keep the current fallback path when company-context assembly fails.
- Expand automated handoff coverage so the final handoff text is validated for company-context ordering, project isolation, budget/truncation behavior, secret redaction, and graceful degradation.

### Out
- No JSON schema changes.
- No `writeHandoff()` signature changes.
- No workflow-engine changes.
- No reimplementation of company-context assembly inside `handoff.mjs`.

## Acceptance criteria
- `factory/lib/handoff.mjs` uses `assembleAgentContext()` and forwards `companyState` through the existing options object.
- Generated handoffs render `## Company context` before the existing `## Factory context (global)` block.
- Tests prove that other-project data is excluded from the company section.
- Tests prove that configured budgeting or truncation is respected in the company section.
- Tests prove that secrets are redacted in the assembled company context.
- Tests prove that company-context assembly failures still degrade through the existing try/catch path and do not block handoff writing.
- The existing factory test suite remains green.

## Non-goals
- Changing the shape of `state`, `companyState`, request/result JSON, or stage schemas.
- Adding new company-context sources outside the tested wrapper.
- Broadening the handoff contract beyond the existing stage output.

## Open strategic decisions
- None. The task contract is sufficiently specific and the wrapper-based implementation path is already established.
