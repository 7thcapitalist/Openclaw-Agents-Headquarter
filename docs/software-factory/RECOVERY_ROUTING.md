# Recovery routing

Recovery diagnosis uses the existing architect runtime with the Recovery prompt.
Repair verification uses the backend-builder runtime with the recovery-verifier
prompt. These use different configured harnesses (Claude and Codex). This
avoids depending on an unregistered `recovery` runtime agent.

The protocol retains the original failed stage for result validation. It carries
`verificationStage` separately so verifying a builder repair does not dispatch
back to the builder's repair route. An explicit `recovery-verify` route takes
precedence. The runner rejects identical repair and verification runtime IDs.

Normal review, QA, security, approval, and release gates still apply after repair.
This changes routing only; it grants no merge, production, or credential authority.

Verification: routing regression tests cover builder-stage recovery and reject a
repair agent verifying its own repair; the recovery workflow test exercises
failure, diagnosis, verification, and resumption through the existing engine.
# Verification limits

The five routing/recovery workflow tests pass, including the actual repair
and verifier runtime identities. Broader missing-result and concurrent-runner
suites have five failures also reproduced on main e43e4df (old failure-routing
and retry expectations). This change does not claim those suites are green.
