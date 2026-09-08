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

- Full factory suite: **281 tests passed**, zero failures.
- Focused regressions cover transport retry limits, prompt-file permissions and
  cleanup, diagnostic redaction, malformed response rejection, task reuse,
  preserved product evidence, decision boundaries, shutdown interruption, and
  integration ownership guards.
- Independent read-only agent review found one integration-resume edge case;
  fixed, regression tested, and re-reviewed with no blocking findings.
- Host logs identify provider exhaustion with a reported reset time. Recovery
  uses that known window rather than changing providers or weakening gates.

## Risks / limits

- The review above is an independent Codex instance; cross-model Claude review
  remains required before merge and is currently limited by provider allowance.
- Reset timing is provider-reported, not a guarantee of service availability.
  Generic automatic retries use bounded backoff, not authoritative credit data.
- The budget prevents new rounds after its deadline; an in-flight round is
  allowed to settle. Stopping a service mid-round can still orphan work if its
  systemd stop timeout expires. Integration recovery is deliberately unsupported.
- Runtime recovery and logs stay private; no provider configuration or secrets
  are included in this change. Main is not changed by this repair branch.

## Next action

Run the repaired loop from this isolated checkout against the canonical HQ,
resume the existing prepared objective after the known provider reset, and
verify architecture/build progress. Obtain cross-model review and founder merge
approval for the repair PR. Review the overnight output through normal gates.
