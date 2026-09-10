# Unified run timeline

Adapted from Paperclip's `activity`, `issue-liveness` and `work-timeline`
services at pinned commit `6abeb67334348dcb6fde2d591a27ffc7efc7118d` under MIT.
See `factory/third-party/provenance.json`. Issue #122.

## The problem

The operational record of one run is spread across **seven files written by
different layers**:

| Layer | File |
| --- | --- |
| workflow | `state.json` events |
| audit | `audit.ndjson` |
| liveness | `liveness.json` |
| ownership | the lease store |
| wakeups | `wakeups.json` |
| cost | `.openclaw-factory/telemetry/cost-events.ndjson` |
| graph | `graph-health.json` |

Answering *"what happened to this run"* meant opening all seven and merging them
by hand. `GET /api/founder/tasks/:id/timeline` merges them once, in order, with
**each entry's source named**.

Naming the source is the point. A disagreement between layers — workflow says
the stage passed, liveness says the run needs follow-up, graph says the node is
diverged from its task — is the single most useful thing a founder can see, and
averaging it away is how a run looks fine while being stuck.

## Honest about its sources

**All seven layers are always listed**, present or not. A layer that recorded
nothing shows as absent with a reason, because a run older than the telemetry
that writes a layer has a gap, and a gap must not be mistaken for a clean
record. A layer that cannot be *read* is named with its error and sets
`available: false` for the whole timeline — an incomplete timeline that looks
complete is worse than an obviously broken one.

The readable layers still render either way.

## The privacy boundary

- **Evidence appears as a path, never as content.** Reading evidence is the task
  view's job, behind its own authorisation.
- **Audit data contributes scalars only.** `data` is already sanitised by the
  audit envelope, and this projection additionally drops any non-scalar value —
  so a field added to the envelope later cannot smuggle a blob through here. A
  test pins that with a nested prompt.
- No prompt, private conversation, credential, or arbitrary file is read.
- Every free-text field from every layer is truncated to 300 characters.

## Bounds

- `taskId` is validated before any path is constructed; `../../etc/passwd` and
  friends throw rather than resolve.
- Cost events and wakeups are filtered to this task; a graph finding is attached
  only when it names this node.
- The entry list is bounded and discloses `truncated`, keeping the **newest**
  entries.
- An unknown task returns `null` — never an empty timeline, which would read as
  a clean run.

## Where it appears

Inside the existing task execution modal, under the stage lane and handoff
stream. The timeline is fetched alongside the execution view and **its failure
cannot hide the execution view**: the stage lane is the founder's primary read,
the timeline is depth.

## Rollback

Revert the PR. This module writes nothing; the route and the section disappear
and the execution view returns to exactly what it showed before.
