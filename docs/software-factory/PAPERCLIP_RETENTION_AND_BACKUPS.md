# Retention, storage and backup health

Adapted from Paperclip's `decision-retention` and `database-backup-health`
services at pinned commit `6abeb67334348dcb6fde2d591a27ffc7efc7118d` under MIT.
See `factory/third-party/provenance.json`. Issue #126.

## The governing rule

**Do not delete material data merely because it is old.**

Everything in `factory/lib/hq/retention.mjs` is read-only. `planRetention()`
produces a plan and removes nothing. `GET /api/hq/retention` reports and cannot
prune. The Today panel has no button and no form — a prune button is how "clear
old files" becomes "clear the record of what the factory did".

The only path that deletes is `npm run factory:retention -- --apply`, and it is
deliberately awkward.

## Retention classes

| Class | Prunable | Minimum age | What it is |
| --- | --- | --- | --- |
| `canonical` | **never** | — | `state.json`, `objective-state.json`, contracts, `control-plane.json` |
| `append-only-audit` | **never** | — | `audit.ndjson`, `cost-events.ndjson`, `permissions.ndjson`, `wakeups.json` |
| `derived` | yes | 30d | `liveness.json`, `graph-health.json`, `metrics.json`, reports |
| `evidence` | yes | `learning.evidenceRetentionDays` (90d) | Gate evidence |
| `ephemeral` | yes | 14d | Per-dispatch handoffs and results |
| `protected` | **never** | — | Anything unrecognised, and any `.pem`/`.key`/`.crt`/`.p12` |

Two properties matter more than the table:

- **An unclassified file is `protected`, not swept.** Unknown data is somebody's
  data until proven otherwise. A test puts an unrecognised file in the tree and
  asserts it is never a candidate.
- **A key is protected wherever it sits** — including under `results/`, which is
  otherwise ephemeral. Extension wins over location.

Every kept file carries `keptBecause`. Saying only "protected" is the kind of
message that eventually gets a `--force` flag added to it.

## Deleting, when an operator really means it

```
npm run factory:retention                                   # report only
npm run factory:retention -- --class ephemeral --older-than 30
npm run factory:retention -- --class ephemeral --older-than 30 --apply --confirm 128
```

`--apply` requires **all** of:

- exactly one `--class`, and that class must be prunable — naming `canonical`
  is refused with the reason it exists;
- `--older-than <days>`;
- `--confirm <n>` matching the plan's **current** count exactly.

If the plan has drifted by even one file since the operator read it, the run is
**refused, not applied**. Somebody who approved "delete 40 results" must never
silently get "delete 400". Each target is re-checked to resolve inside the state
root before removal.

While these tests were being written, a bug pointed the CLI tests at the real HQ
state tree. The confirmation guard refused every run and nothing was lost —
accidental but real proof that the guard is what stands between a mistake and
data loss.

## Backup health

`inspectBackupHealth()` reports, and never creates, moves, or configures a
backup — changing a backup destination is a founder decision.

- **No configured directory** reports `not-configured`, never "healthy". Silence
  is not good news.
- A missing or unreadable directory is a warning with its own status.
- The newest archive is **hashed**. A backup nobody has ever read is a hope, not
  a backup, and reading it is the only way to know it is not truncated.
- **A zero-byte archive is worse than none**, because it looks like a backup. It
  is called out explicitly.
- A failure marker (`backup.failure`, `db-backup.failure`,
  `db-backup-to-s3.failure`) surfaces even when a recent archive exists.

Point it at a directory with `FACTORY_BACKUP_DIR` or `--backup-dir`.

## Storage visibility

Bytes and file counts per class, so growth has a cause rather than a number.
Against the live tree when this was written: 407 files, 2.5MB — 316 ephemeral
(1.4MB), 47 canonical (969KB), 34 derived, 10 protected, **0 eligible** because
nothing had aged past its minimum.

## Operating it

- **Health:** `available: false` or a `warning`/`missing` backup status means a
  source could not be read. `eligibleBytes` is what a prune would actually free.
- **Recovery:** every diagnostic here is non-destructive; running any of it
  repeatedly is safe.
- **Rollback:** revert the PR. The library writes nothing, and the CLI only ever
  ran when an operator typed `--apply --confirm`.

## Boundaries

No automatic pruning, no scheduler, no retention daemon. Nothing deletes without
a person naming the class, the age, and the exact count.
