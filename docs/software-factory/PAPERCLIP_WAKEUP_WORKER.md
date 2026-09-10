# Durable wakeup worker

`npm run factory:wakeup` processes at most one durable wakeup. It claims the
request, acquires an atomic per-task lease, calls the existing OpenClaw factory
runner, records success/retry/dead-letter state, and releases its lease.

Wakeups contain identifiers and context references only. They cannot contain a
command or arbitrary payload, and this worker does not broaden the registered
agent `./run.sh` boundary. Scheduling is intentionally not installed or enabled
by this change; an operator may invoke the bounded command from an existing
private scheduler after verifying paths and health.

Optional private runtime overrides are `FACTORY_STATE_ROOT` and
`FACTORY_WAKEUP_QUEUE`. Neither belongs in Git. A failed run is retried only up
to the wakeup's recorded `maxAttempts`, then retained as a dead letter for
operator inspection.

## Rollback

Revert the PR, or simply stop invoking `npm run factory:wakeup` — the worker
processes exactly one wakeup per invocation and installs no scheduler, so not
running it is a complete disablement. An in-flight wakeup releases its lease on
exit; a lease left behind by a killed process expires on its own.
