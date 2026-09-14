# Headquarters Control Plane on Vercel

Delivery campaign for SFD-2026-012 / `decision-cards/DC-2026-003-hq-on-vercel.md`.
The decision is signed; this is the work that makes it real.

- Authorization: explicit founder direction on 2026-09-13, on top of the Option A
  signature of 2026-09-12
- Campaign id: `HQ_CONTROL_PLANE_2026`
- Shared base: `8f61249` (`main`, "feat(factory): add the founder intent protocol")
- Integration owner: Claude (architecture and independent review; Codex builds,
  per the cross-review matrix — Claude does not review code it authored)
- Target: `main`, one short-lived branch/worktree and PR per node
- Expiry: issues #186–#191 merged, cancelled, or superseded by a founder decision
- Topology: Vercel holds the mirror and the intent queue; the factory machine is
  outbound-only and never accepts an inbound connection

## Why a campaign

The six nodes below are not independent. Nothing renders until something is
stored, nothing is stored until something publishes, and the tunnel cannot be
retired until all of it works. SFD-2026-010 exists for exactly this shape: the
PRs are prepared from one recorded base and merged in a declared order, each on
its own branch and worktree, each still reviewed and still merged by a human.

## Where this started

The Vercel project `openclaw-agents-headquarter` currently returns
`404 NOT_FOUND` on every path. The build is not broken — it is empty:

```
Running "vercel build"
Build Completed in /vercel/output [329ms]
Skipping cache upload because no files were prepared
```

Vercel cloned the repository, found no framework, no `vercel.json`, no root
`index.html` and no `api/` directory, and deployed nothing. Adding build config
would not have helped. HQ cannot run on Vercel at all: the dashboard spawns
`openclaw` and `pm2`, drives git worktrees on disk and reads a local SQLite
database, and Vercel is serverless. That is the finding SFD-2026-012 already
recorded, now confirmed against a real deployment.

What goes on Vercel is a **different, smaller application** that renders a
published projection. Node 1 makes the URL serve something; nodes 2-5 make it
serve Headquarters; node 6 closes the inbound path the decision exists to close.

## What is already merged

| Piece | Where | Property to preserve |
| --- | --- | --- |
| Publish boundary | `factory/lib/hq/mirror.mjs` (#182) | the only place that decides what leaves the machine; performs no network I/O |
| Intent protocol | `factory/lib/integrations/intent-protocol.mjs` (#183) | validates and records; executes nothing; no network I/O; closed allowlist |

Both were built as halves on purpose. The campaign supplies the other halves
without merging the two concerns back together.

## Ordered PR train

| Order | Issue | Node | Depends on | Risk |
| --- | --- | --- | --- | --- |
| 1 | #186 | Serve the control-plane app shell | — | low |
| 2 | #187 | Store the mirror behind an authenticated write endpoint | #186, **DC-2026-004** | high |
| 3 | #188 | Publish the snapshot outbound from the machine | #187 | medium |
| 4 | #189 | Render the published mirror as the HQ view | #187 | low |
| 5 | #190 | Complete the founder intent round trip | #188, #189 | high |
| 6 | #191 | Retire the Cloudflare tunnel | #190 | medium |

Node 1 carries no company data and no credential, so it can land while
DC-2026-004 is still open. Node 2 is where company data first reaches a public
URL, and it is blocked until that card is signed.

## Founder decision this campaign surfaced

**DC-2026-004 — who may read the hosted Headquarters view.**

DC-2026-003 settled the network boundary, the data scope, the credential, the
retention and the rollback. It did not settle viewer authentication. The local
dashboard is password-protected and session-bound; a `*.vercel.app` URL is
public by default. The signed data scope — founder inbox, cost totals, goal
titles, agent scorecards — is the whole company on a public address unless a
decision says otherwise.

This was not an oversight to work around silently. It gates node 2 and is
written up in `decision-cards/DC-2026-004-hq-viewer-auth.md`.

## Deferred decisions

Recorded rather than escalated, per the operating rules. Each is reversible, and
the mirror is disposable by design.

- **Store backend** — Vercel Blob, chosen for a single-writer disposable mirror
  with no query needs. Revisit if the intent queue wants atomic claim semantics
  that Blob makes awkward; a swap touches node 2 only.
- **Poll interval** — start at 30s, tune against the cost ledger once node 5 is
  live. The founder-visible cost is approval latency, which already waits on a
  human.

## Constraints on every node

- separate branch and worktree from `8f61249`; no shared branch, no integration
  branch, no stacked PR target
- PR body declares campaign id, dependencies, merge position, verification and
  rollback
- immediately before merge: refresh from latest `main`, resolve, rerun checks,
  preserve independent review and QA evidence; an earlier green result is stale
  once a predecessor merges
- the publish boundary is widened only in `mirror.mjs`, never by a new panel
- an intent identifies an action and never carries a command
- nothing grants an agent new authority; `prohibitedAutonomousActions` and the
  signed founder-approval gate are unchanged

## Rollback

Unchanged from DC-2026-003, and re-verified before node 6 merges:

1. stop the publisher — the hosted view goes stale and says so
2. delete the Vercel project — HQ is reachable on `:3211` locally, unchanged
3. `git revert` the campaign commits — the factory never depended on any of it

The local dashboard keeps working throughout. Nothing in this campaign makes the
factory require the network to run.
