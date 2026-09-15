# Decision Required

## Decision

What retention window should compact the idempotency ledger — keeping each
command's key and nulling its stored payload — now that #238 has removed 98.6%
of the bytes that window was meant to reclaim?

## Why this needs the founder

You asked for the window to be proposed before it is implemented. The proposal
turns out to be worth less than it looked, and the residual growth is somewhere
else — in the canonical event log. Deciding to trim that is a decision about
what the audit record shows, which is yours, not mine.

## What was measured

After #238, a synthetic task driven through 5,000 committed mutations (each
appending one event, as every real mutation does), state document growing to
596 KiB:

| | rows | payload |
|---|---|---|
| `commands.response_json` | 5,001 | **112 KiB** |
| `events.payload_json` | 5,001 | 590 KiB |
| `state_revisions` | 5,001 | 195 KiB |
| `entity.state_json` | 1 | 596 KiB (rewritten in place each mutation) |
| **store on disk** | | **7.9 MiB — 1,658 bytes/mutation** |

Before #238 the `commands` payload alone would have been ~2.9 GiB for the same
run. It is now 1.4% of the store.

Two consequences:

1. **The ledger window reclaims 1.4% of a long task's store.** The mechanism is
   still correct and still worth having as a bounded policy; it is just no
   longer the thing standing between us and a full disk.
2. **The remaining growth driver is `state.events[]` inside the document.** It
   is append-only and unbounded, so the entity row grows, and every mutation
   rewrites it. That is the one genuinely quadratic thing left — in write
   traffic, not in file size, since SQLite reuses pages.

Headroom at the measured rate: the 1 GiB ceiling (#224) is reached at ~650,000
mutations. A healthy seven-stage task does 32.

## Option A — ledger payload window only (the shape you asked for)

Null `commands.response_json` for rows older than **30 days**, and only on
entities whose current status is `merged`, `verified`, or `failed`. The key,
`entity_id` and `applied_at` stay, so a late duplicate still short-circuits as
already-applied.

Why 30 days, and why the status gate: the longest *bounded* replay horizon in
the system is 90 minutes (the auto-retry sweep's stale threshold; the yielded
wait is 60 minutes). 30 days is ~480× that. The one **unbounded** horizon is
`merge-reconcile:<statePath>:<sha>`, which can be re-presented whenever the
sweep next runs — and which applies only to tasks sitting at `merge-ready`. The
status gate excludes those entirely, so the unbounded case never meets the
window.

A replay that finds a compacted row throws, naming the command and the window,
the same way #238 handles an unreplayable key. #235 makes that throw visible in
the Founder Inbox rather than silent.

- Benefit: bounded, principled policy; matches the shape you specified; no
  change to any live task's replay semantics.
- Cost/risk: reclaims ~1.4% of a long task's store. Real but small. Adds a
  sweep and a compaction path to maintain.

## Option B — Option A, plus a window on the canonical event log

Everything in A, and additionally cap `state.events[]` in the document: keep
the most recent N events inline, move the older ones to the `events` table
only, and record in the document that they were rolled over.

- Benefit: addresses the actual remaining growth driver. Write traffic per
  mutation stops rising with task age.
- Cost/risk: **the document stops being a complete record of itself.** Every
  reader that walks `state.events[]` — completion reports, the run timeline,
  decision history, the learning agent — would see a truncated log unless it
  learns to read the table too. That is a real behaviour change to the audit
  surface, and it is why it is a separate decision rather than something I
  folded into A.

## Other

You may set a different window (7 days, 90 days), a different status gate, or
decide the ledger window is not worth building at all now that #238 has taken
the bytes out — in which case this PR delivers only the retention-report
visibility half, which is already built and tested here.

## Recommendation

**A**, at 30 days with the status gate. It closes the ledger story with a policy
we can state and test, and it costs little. I would not do B yet: at 1,658
bytes per mutation the ceiling is ~650,000 mutations away, so there is no
pressure forcing a change to what the audit log shows, and that change should
be made deliberately rather than as a side effect of a disk-space fix.

If you want only the visibility half for now, that is a defensible call and this
PR is already that.

## Default if no decision

The retention-report visibility change in this PR is independent and safe to
merge on its own: `state.sqlite` and its WAL/SHM siblings are classified
`canonical`, so their bytes appear in every storage total instead of being
invisible, and they remain undeletable. No compaction is implemented, so
nothing about replay behaviour changes. The 1 GiB ceiling (#224), the loop
guard (#237) and the ledger shrink (#238) all remain in force.

## Reply format

`A`, `B`, or `Other: ...`.
