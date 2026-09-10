# Approval and decision history

Adapted from Paperclip's `approvals` and `issue-approvals` services at pinned
commit `6abeb67334348dcb6fde2d591a27ffc7efc7118d` under MIT. See
`factory/third-party/provenance.json`. Issue #120.

## This is a projection, not a gate

Paperclip's `approvals` table **is** the authority: writing
`status: "approved"` into a row authorises the work. HQ deliberately inverts
that.

The authority here is, and stays, the Ed25519 assertion verified by
`validateFounderAssertion()` in `factory/lib/task-workflow.mjs` against the
public key snapshotted into the task at creation. `decision-history.mjs` only
**reads** canonical task state and reports what already happened.

The consequence is the property that matters: **there is no function in this
module that can approve anything, and no file it writes that any gate reads.**
Adding a row to this history grants nothing. A test asserts the module's entire
export surface is `DECISION_STATES` and `buildDecisionHistory` — if someone adds
a writer, that test fails. `GET /api/hq/decisions` deliberately has no POST
sibling: a second place to approve things is a second thing to compromise.

## Derived lifecycle

Every state is computed from canonical events; none is stored.

| State | Derived from |
| --- | --- |
| `requested` | A `founderApprovalRequest` exists with no decision recorded |
| `approved` | `founder-approval-recorded` present, but the work has not resumed |
| `consumed` | An approval the build **actually resumed on** — a `task-resumed` after it |
| `rejected` | `founder-approval-rejected`, and later than any approval |
| `revoked` | `founder-approval-authority-rekeyed` before any decision — the signature it waited for can no longer be produced |
| `expired` | A stale request on a task nobody is waiting on |

`approved` and `consumed` are separate on purpose: an approval that never moved
the work is a different fact from one that did, and only the second means the
high-risk build happened.

**Expiry is a reading of the record, never an action on it.** A live task still
awaiting the founder is never expired away, no matter how old, because the
founder still owes it an answer. Reading the history twice returns identical
results; nothing is consumed or aged by looking at it.

## Founder decisions that are not approvals

A `decision-required` blocker is also something the founder owns, and it belongs
in the same history: *"what have I been asked, and what did I answer"* is one
question, not two. Those rows carry the blocker's stage and classification and
reference the Decision Card by path.

An approval row never borrows an unrelated blocker's text — a task can carry a
recovery escalation and an approval request at the same time, and an early
version of this made the approval row describe the recovery.

## What is deliberately not published

Identifiers and verification facts only. The signed assertion, the signature,
the challenge value, and the evidence body all stay in task state. The key
fingerprint is truncated. Publishing any of it buys nothing and widens the blast
radius of a read endpoint. Tests assert the challenge and signature never appear
in the response.

## Degraded behaviour

An unparsable task state lands in `warnings` with `available: false` and the
readable decisions still render. An empty factory reports an empty history, not
a failure.

## Health

- `summary.awaitingFounder` is work stopped on the founder. It is the number the
  panel leads with.
- `summary.unsigned` is approvals recorded **without** a verified signature. It
  should always be zero; the panel calls any other value out loudly, because a
  non-zero value means either a bug or a bypass.

## Rollback

Revert the PR. This module writes nothing, so there is no state to repair and
nothing to migrate — the route and panel simply disappear.
