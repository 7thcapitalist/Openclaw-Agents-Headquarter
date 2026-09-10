# Hierarchical goals and progress rollups

Adapted from Paperclip's `goals` service (`server/src/services/goals.ts`,
`server/src/routes/goals.ts`) at pinned commit
`6abeb67334348dcb6fde2d591a27ffc7efc7118d` under MIT. See
`factory/third-party/provenance.json`.

## What this gives the founder

One answer to "are we actually moving?" — a company → project → objective tree
whose every number comes from canonical factory work, not from anyone's claim.

## The one rule that makes it trustworthy

**A goal has no status of its own.** Paperclip stores `status` on the goal row
and lets it be edited. HQ deliberately does not. A goal here carries intent
only:

| Field | Meaning |
| --- | --- |
| `id` | Stable identifier |
| `level` | `company`, `project`, or `objective` |
| `title` | What the founder wants |
| `parentId` | Parent goal (required except at `company`) |
| `projectId` | Canonical project key (required at `project` and `objective`) |
| `objectiveId` | Canonical objective id (required at `objective`) |

Status and percentage are computed in `factory/lib/hq/goals.mjs` from objective
and task state. An agent that writes `"status": "completed"` into a goal changes
nothing — the projection ignores unknown fields and there is a test that proves
it. This is why goals cannot become a second, competing workflow state.

## Where goals live

`factory/goals.json`, tracked in Git. Changing company intent is therefore a
reviewed pull request with the same audit trail as any other change. **There is
no write API.** `GET /api/hq/goals` is read-only by construction, so the
dashboard cannot become a second place where direction is edited unreviewed.

## How progress is derived

- An **objective goal** rolls up the nodes of its objective (including the
  integration node), falling back to the objective's own status when
  decomposition has not produced nodes yet.
- A **project goal** rolls up its objective-goal children; with none, it rolls up
  *every* canonical objective in `projectId`. Naming a project is enough to get
  a real number — you do not have to enumerate objectives.
- A **company goal** rolls up its children.
- `blocked` outranks `active`, which outranks `pending`, so a rollup surfaces
  what needs attention rather than the most flattering number.
- Work HQ cannot see reports `unavailable`, never `0%`.

### Reading canonical status honestly

Canonical state reaches this module in three vocabularies and two cases: node
statuses from the objective orchestrator (`gate-satisfied`, `published`,
`skipped`, `blocked-by-dep`), task workflow statuses (`merge-ready`, `blocked`),
and the uppercase founder-facing `status6` from `presenter.mjs` (`COMPLETE`,
`WAITING_FOR_FOUNDER`). Everything is lowercased before lookup, so a projection
never depends on which layer supplied the value.

Three rules keep the result honest when the data is imperfect:

- A status in **no** bucket is counted as `unknown`, never dropped. Silently
  ignoring it is what turns a vocabulary drift into a confident `0%`.
- A leaf with no canonical source has `total: 0`, so summing totals alone would
  erase it and let a parent claim `100%` while half its scope is unaccounted
  for. The rollup carries an `unavailable` count and reports `partial`; the
  panel then shows the label instead of a percentage that would be
  arithmetically correct and operationally a lie.
- An objective can be **blocked above its tasks** — a founder gate, a failed
  publication — while every task under it reads complete. The percentage stays
  task-derived, but the objective's own verdict outranks its tasks', so the
  state never claims done for work that cannot proceed.

## Validation

`validateGoalTree` rejects unusable identifiers (including `..` path segments,
because these ids are the natural path segments once a projection is
persisted), duplicates, missing or
wrongly-levelled parents, cycles (including self-parenting), oversized titles,
a `project` goal without `projectId`, an `objective` goal without both ids, and
any child whose `projectId` differs from its parent's. A malformed registry
fails the read; it does not produce a half-tree.

## Degraded behaviour

`buildGoalsSnapshot` never throws. A missing registry reports
`configured: false`; a missing state root, an unparsable objective file, or an
invalid tree lands in `warnings` with `available: false`, and the readable part
of the projection still renders. Goals are a read-only view and must never be
able to stop the factory.

## Operating it

- **Enable:** add goals to `factory/goals.json` and merge. The Today view's
  Goals panel and `GET /api/hq/goals` pick them up on the next load.
- **Health:** `available: false` with `warnings` means a canonical source could
  not be read — the totals shown are incomplete, and the panel says so.
- **Rollback:** delete `factory/goals.json` (or empty its `goals` array). The
  panel returns to "Not configured" and nothing else changes; no factory
  behaviour, task state, or routing depends on goals. Reverting the PR removes
  the route and panel entirely.

## Boundaries

Goals inform the founder. They do not gate, route, prioritise, or authorise
anything, and no factory transition reads them.
