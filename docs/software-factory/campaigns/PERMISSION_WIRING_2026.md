# Permission Wiring Campaign

- Authorization: explicit founder direction on 2026-09-14 ("Solve all the fixes
  then wire the remaining capabilities. Make sure to run a campaign to do all of
  it.")
- Policy: SFD-2026-010
- Shared base: `90ade8bd45f9f44e2f8158ca8652865efd9c622f` (`main` after #204)
- Integration owner: Claude (builder for this campaign under
  `factory/prompts/builder.md`; every PR needs an independent reviewer)
- PR target: `main`
- Expiry: closes when positions 1–5 below are merged or explicitly cancelled

## Scope

Two problems, one campaign, because the second cannot be trusted without the
first.

**1. The suite is not green, so "tests pass" proves nothing.**
`npm run test:factory` reports failures in this checkout that are not defects in
the code under test. The two causes overlap — installing the missing workspace
reveals the second — so the counts below are each measured with the other cause
removed:

| Cause | Count | Why it fails |
| --- | --- | --- |
| `@vercel/blob` unresolved | 9 | `control-plane/` declares it, but `npm run setup` only installs `dashboard/backend`. CI installs it explicitly; a developer machine never does. Fixed at the root in 1a: the routes load the package on demand, so no test needs it installed at all. |
| Ambient founder key | 24 | The founder-authority tests assert "no anchor configured" while reading the real enrolled key from `dashboard/backend/data/`, which is gitignored — so they pass in CI and in every worktree, and fail in the only checkout that has real founder state. |

A third problem sits underneath both and is not visible as a failure at all: a
fresh worktree has no `node_modules`, and the dashboard security tests SKIP
themselves rather than fail when their dependencies are absent. Full-suite runs
from a worktree were silently skipping 17 tests. Position 1 turns that into a
refusal to start.

Both are environment-dependence, not logic. Both make the release gate's
"tests pass" evidence weaker than it reads.

**2. Scoped permissions is one-seventh wired.**
`factory/permissions.json` (#205) turns the registry on in `report` mode, but
only `task.initialize` has a call site. Six capabilities are defined, granted,
audited by nothing, and asked about nowhere:

| Capability | Enforcement point |
| --- | --- |
| `task.dispatch` | `factory/lib/openclaw-protocol.mjs` — where a stage dispatch is created |
| `github.open-pr` | `factory/lib/hq/github-publish.mjs` — `publishMergeReadyTask` |
| `objective.run` | `factory/lib/objective/orchestrator.mjs` — `runObjective` |
| `objective.recover` | `factory/lib/objective/orchestrator.mjs` — `resumeObjectiveNodes` |
| `interaction.post` | `factory/lib/hq/interactions.mjs` — `appendInteraction` |
| `wakeup.enqueue` | `factory/lib/wakeups/queue.mjs` — `enqueueWakeup` |

## Ordered delivery

| Position | PR | Change | Dependency |
| --- | --- | --- | --- |
| 0 | this one | Campaign tracker | None |
| 1a | #209 | Control-plane routes stay importable without `npm install` there | None |
| 1b | #208 | The suite installs what it needs, and refuses to start when a silent-skip workspace is missing | 1a |
| 2 | #212 | Founder-authority tests stop reading live machine state | None |
| 3 | | The shared capability-check seam, plus `task.dispatch` and `github.open-pr` | 1, 2 |
| 4 | | Wire `objective.run` and `objective.recover` | 3 |
| 5 | | Wire `interaction.post` and `wakeup.enqueue` | 3 |

Positions 1 and 2 are independent of each other and of everything else; they
come first because positions 3–5 claim "the suite is green" as their
verification evidence, and that claim is only worth something once it is true.

1a must land before 1b, and the two solve different halves. 1a removes the
dependency the tests were failing on; 1b catches the workspace whose absence
makes tests *skip* instead of fail — the failure mode that reports green. Only
the second kind earns a refusal to start: a preflight that blocks on a
dependency nothing is waiting for would take back what 1a bought, which is a
factory agent's fresh worktree being able to run the control plane's auth
tests at all.

Position 3 carries the seam every later position calls. Each check is the same
ten lines — read the registry, fail loudly if it is unreadable, return early
when enforcement is off, then `enforce` — and six hand-copied versions of a
policy decision is how one of them quietly ends up missing the early return.
Positions 4 and 5 therefore depend on 3 rather than duplicating it, as this
campaign's own rule against copying from an unmerged predecessor requires. They
are independent of each other and touch disjoint files, so they may merge in
either order once 3 has landed.

## Relationship to #205

`factory/permissions.json` is in flight as #205 and is **not** a hard dependency.
The registry loader treats a missing file as `off`, where every check allows with
`reason: "enforcement-disabled"` — so a wired capability with no registry is a
no-op, not a failure. If #205 merges first, positions 3–5 begin producing audit
records immediately; if it merges later, they begin then. Neither order breaks
anything.

Every capability wired here is already granted by #205's table, so no position
in this campaign adds or widens a grant.

## Invariants

- Nothing in this campaign changes what the factory is *allowed* to do. The
  permission system is strictly subtractive and runs in `report` mode: every
  decision is computed and audited, then the work is allowed anyway.
- No position may switch the registry to `enforce`. That is a separate founder
  decision, taken after the `report`-mode audit log at
  `.openclaw-factory/telemetry/permissions.ndjson` has been read.
- A missing or unreadable registry must continue to mean "off", never "deny".
  A permission check that can halt the factory when its config is absent is an
  outage, not a control.
- The founder bypass (`actorType: "human"`, and any verified founder approval)
  stays superior at every new call site.
- Human-only merge, independent review, QA evidence, one writer per worktree,
  and `./run.sh` are unchanged.
- No campaign PR may deploy, publish, purchase, delete production data, or
  broaden network exposure.

## Merge procedure

The founder merges in the table order for positions 1–2, then 3–5 in any order.
Immediately before each merge, the integration owner refreshes that PR against
the then-latest `main`, resolves conflicts, reruns `npm run test:factory`, and
confirms the PR contains only its coherent change. A green check from the shared
base is stale once any predecessor has merged.

## Rollback

Each position is independently revertable.

- Positions 1–2 are test and setup changes; reverting restores the previous
  (failing-locally) suite and nothing else.
- Positions 3–5 each add `enforce(...)` calls at mutation entrypoints. Reverting
  any one restores the unwired behaviour for those capabilities. Deleting
  `factory/permissions.json` disables all of them at once without a code change,
  which is the faster lever if a wired check ever misbehaves.
