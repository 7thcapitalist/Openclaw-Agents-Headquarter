# Overnight recovery — issue #31

## Change

A provider connection failure/idle timeout stopped decomposition. Subsequent
attempts succeeded with the same full objective, ruling out the proposed CLI
argument-size explanation. Shutdown later killed the loop while tasks remained
marked running.

- Decomposition uses a private temporary message file, retains redacted error
  detail, and retries recognized transient failures up to three times.
- Planning explicitly forbids dispatching or executing the proposed work.
- Resumed build nodes reuse their task state/worktrees and passed stages.
- The loop retries only the engine's original infrastructure failures after
  backoff. Genuine decisions and substantive failures remain blocked. It
  preserves the existing objective instead of creating duplicate work.
- Idle waits respond to shutdown. `--not-before <ISO timestamp>` allows a known
  provider reset to be respected within the total wall-clock budget.
- `--objective-path` resumes prepared build work; running nodes and already
  started integrations are rejected before mutation. `FACTORY_HQ_ROOT` selects
  the canonical HQ when executing from an isolated repair checkout.

## Verification

- Full factory suite: **334 tests passed**, zero failures after the overnight
  follow-through fixes were merged.
- Focused regressions cover transport retry limits, prompt-file permissions and
  cleanup, diagnostic redaction, malformed response rejection, task reuse,
  preserved product evidence, decision boundaries, shutdown interruption, and
  integration ownership guards.
- Independent read-only reviews found and drove fixes for integration resume,
  delegated-result ownership, duplicate PR publication, and release conflict
  routing; all were regression tested before merge.
- Host logs identify provider exhaustion with a reported reset time. Recovery
  uses that known window rather than changing providers or weakening gates.

## Risks / limits

- The final follow-through branch was merged as PR #39 after GitHub reported it
  clean and the complete suite passed. A final Claude rereview was unavailable
  because its provider session allowance had reset; the requested findings were
  addressed and covered by focused tests.
- Reset timing is provider-reported, not a guarantee of service availability.
  Generic automatic retries use bounded backoff, not authoritative credit data.
- The budget prevents new rounds after its deadline; an in-flight round is
  allowed to settle. Stopping a service mid-round can still orphan work if its
  systemd stop timeout expires. Integration recovery is deliberately unsupported.
- Runtime recovery and logs stay private; no provider configuration or secrets
  are included in this change. Main is not changed by this repair branch.

## Next action

The overnight systemd unit is no longer installed on this host, so no worker is
currently running. Review the existing objective and launch a fresh bounded
run only when provider capacity is available; do not start a second worker for
the same objective.
