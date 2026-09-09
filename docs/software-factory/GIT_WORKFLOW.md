# Repository and Git Workflow — NON-NEGOTIABLE

This is a repository-level invariant. It applies to every change, made by
anyone or anything:

- founder / manual development
- Claude Code
- Codex
- Cursor
- OpenClaw factory agents
- automated recovery
- QA agents
- infrastructure / maintenance jobs

No agent, provider, recovery path, or UI workflow may bypass it.

## The model: main-only

`main` is the single canonical and permanent branch. It is the only long-lived
branch in this repository.

Every repository change MUST be delivered through a new Pull Request targeting
`main`.

**NEVER push directly to `main`.**

GitHub requires a head branch for a PR, so short-lived ("ephemeral") PR
branches are allowed. They must never become permanent development branches.

## Required lifecycle

```
current main
  -> create ephemeral branch / worktree
  -> implement ONE coherent change
  -> tests / QA / evidence
  -> PR targeting main
  -> review / required gates
  -> merge into main
  -> delete branch
  -> delete worktree
  -> all future work starts from the new main
```

## What is not allowed

Do not create or maintain, as part of normal operation:

- feature branches that outlive their PR
- development / integration branches
- per-agent branches used across multiple tasks
- long-lived worktrees

If several independent changes are in flight, each becomes its own PR against
`main`. They are not accumulated on a shared branch.

If an existing PR already contains a materially different change, do not add
unrelated work to it. Open a new PR from the latest `main`.

## Before starting new work

Synchronize with the latest `main`. Do not assume an existing local branch or
worktree is current. After a PR merges, treat its branch and worktree as
disposable and do not continue from that stale state.

## Founder-authorized multi-PR campaigns

A bounded campaign may prepare multiple PRs before any of them merge only when
the founder explicitly authorizes that delivery shape. This is an exception to
the normally sequential "merge, then start the next task" rule, not an exception
to PR delivery, isolation, review, verification, or human merge.

Every campaign must:

- name its scope, shared `main` base commit, ordered issue/PR list, dependencies,
  integration owner, and expiry condition in a durable campaign tracker;
- create every change on a separate branch and worktree from that recorded
  `main` commit; never share a writable branch or use an integration branch;
- keep every PR coherent and targeting `main`;
- declare its campaign, dependency PRs, intended merge position, verification,
  and rollback in the PR body;
- avoid silently duplicating code from an unmerged predecessor; use an explicit
  compatibility seam or mark the PR blocked on that predecessor;
- merge in the declared order; immediately before each merge, update that PR
  with the latest `main`, resolve conflicts, rerun its checks, and preserve
  independent review/QA evidence;
- treat GitHub's earlier green result as stale after any predecessor merges;
- delete each branch/worktree after merge and close the campaign after its last
  PR or expiry.

Campaign authorization does not permit direct pushes, stacked PR targets,
shared branches, agent self-merge, skipped gates, production actions, or changes
outside the declared scope. A campaign PR may remain open while dependencies are
unmerged, but it is not merge-ready until those dependencies are merged and its
latest-main refresh succeeds.

## What the factory must always know

For every change in flight:

- which `main` commit the work started from
- which PR owns the change
- whether that PR is open, merged, or closed
- whether the associated worktree still exists
- whether cleanup (branch + worktree deletion) has completed
- campaign id, shared base, merge position, dependencies, and latest-main
  refresh status when the change belongs to a campaign

## Relationship to other rules

This strengthens and does not replace:

- `AGENTS.md` — "Keep `main` releasable. Work through branches and PRs."
- `docs/software-factory/DECISIONS.md` — SFD-2026-001 (GitHub is the durable
  record), SFD-2026-003 (V1 human-merge mode), SFD-2026-008 (this policy).
- `factory/factory.config.json` — `prohibitedAutonomousActions` includes
  `push-to-main`; `gitWorkflow` records the main-only model machine-readably.
- `docs/software-factory/OPERATING_RULES.md` — branch/PR lifecycle.

Human-merge mode (SFD-2026-003) is unchanged: agents open PRs and declare them
merge-ready; the founder merges.
