# Paperclip-derived capability activation runbook

This runbook activates the native HQ capabilities adapted from Paperclip. It
does not run Paperclip as a service and does not change GitHub, HQ, OpenClaw,
human approval, or `./run.sh` authority.

## Merge and enablement order

1. Merge the original capability PRs #96, #97, #98, and #99 after their earlier
   predecessors (#89–#95).
2. Merge runtime telemetry PR #105.
3. Merge bounded wakeup worker PR #106.
4. Merge operations API PR #107.
5. Merge Today operations panel PR #108.
6. Refresh this proof PR from current `main`, run the checks below, obtain an
   independent review, and merge it last.

No production scheduler is installed. After merge, run one bounded local check:

```bash
npm run factory:wakeup
```

An empty queue returns `{"status":"idle"}`. Configure private runtime paths
only through `FACTORY_STATE_ROOT` and `FACTORY_WAKEUP_QUEUE`; do not commit them.

## Health and recovery

- Today / Factory control shows active liveness, leases, queue depth, dead
  letters, recent attributed events, and recorded token usage.
- `available: false` or warnings from `/api/hq/operations` mean a projection is
  degraded. Canonical task state continues operating.
- A queued retry is safe to process again. A dead letter requires operator
  inspection; do not blindly recreate it.
- An unexpired lease means another worker owns the task. Do not force-release
  it unless the owner is proven dead and the normal founder/operator recovery
  procedure records the reason.

## Retention and rollback

Audit and cost ledgers are append-only private runtime evidence. Establish a
host-specific retention policy before sustained scheduling; do not place these
files in Git. To disable activation, stop the external scheduler first, leave
queued items intact, and stop invoking `factory:wakeup`. The API/UI are
read-only and may remain. Projection files can be archived or rebuilt without
rolling canonical task/GitHub state backward.

## Verification

```bash
node --test factory/test/paperclip-activation-e2e.test.mjs
npm run check:provenance
```

The synthetic scenario proves success and retry behavior without credentials,
network calls, spend, deployment, or production data.

## Live Gateway boundary

PR #99 supplies credential-free contract coverage only. Connecting a real
OpenClaw Gateway endpoint changes private host/network and credential posture;
it remains disabled until the founder approves a Decision Card describing host,
data scope, retention, and rollback. Credentials must stay in private OpenClaw
state or environment configuration, never this repository.
