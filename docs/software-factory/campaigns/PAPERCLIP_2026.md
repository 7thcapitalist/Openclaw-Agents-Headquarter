# Paperclip Capability Integration Campaign

- Authorization: explicit founder direction on 2026-09-09
- Policy: SFD-2026-010
- Shared base: `c08a5f7fdc8e8713e5259e185d25fc0eefc0a1d6`
- Integration owner: Codex primary agent
- PR target: `main`
- Expiry: closes when issues #79–#88 are merged or explicitly cancelled
- Architecture: native HQ capabilities with attributed Paperclip reuse; no
  Paperclip service, production exposure, or control-plane authority migration

## Ordered delivery

| Position | Issue | Capability | Dependency |
| --- | --- | --- | --- |
| 1 | #79 | Third-party provenance and license enforcement | None |
| 2 | #80 | Actor-attributed append-only audit envelope | #79 |
| 3 | #81 | Atomic task leases | #79, #80 |
| 4 | #82 | Wakeup protocol and durable queue | #79–#81 |
| 5 | #83 | Run liveness separate from task lifecycle | #79–#82 |
| 6 | #84 | Append-only normalized cost ledger | #79, #80 |
| 7 | #85 | Agent org/capability metadata | #79, #80 |
| 8 | #86 | Read-only Agent Companies package linter | #79 |
| 9 | #87 | Sanitized Agent Companies exporter | #79, #86 |
| 10 | #88 | OpenClaw Gateway interoperability harness | #79, #80, #82, #83 |

Each implementation PR is prepared in its own worktree from the shared base and
targets `main`. Because later PRs may depend on files not yet merged, their PR
bodies must identify missing predecessors and they remain blocked. They must not
silently copy predecessor implementations.

## Merge procedure

The founder merges in the table order. Immediately before each merge, the
integration owner updates that PR with current `main`, resolves conflicts,
reruns focused and full applicable checks, updates evidence, and confirms that
the PR contains only its coherent change. A previous green check from the shared
base is insufficient.

## Invariants

- GitHub and HQ remain authoritative for software work.
- OpenClaw remains the orchestrator/execution runtime.
- Human-only merge, signed high-risk approval, independent review, QA evidence,
  one writer per worktree, and `./run.sh` remain unchanged.
- Paperclip material is pinned, classified, attributed, and licensed.
- No credentials, private OpenClaw state, or generated personal data enter Git.
- No campaign PR may deploy, publish, purchase, delete production data, or
  broaden network exposure.

## Native activation extension

The founder explicitly authorized continued implementation on 2026-09-09
without waiting for each predecessor merge. The activation extension remains
native and credential-free and expires when issues #100–#104 are merged or
cancelled.

| Position | Issue | PR | Capability | Dependency |
| --- | --- | --- | --- | --- |
| 1 | #100 | #105 | Runtime audit, liveness, and cost projections | #91, #94, #95 |
| 2 | #101 | #106 | Bounded wakeup worker under atomic leases | #92, #93 |
| 3 | #102 | #107 | Sanitized operations API | #105, #106 |
| 4 | #103 | #108 | Today operations panel | #107 |
| 5 | #104 | this PR | End-to-end proof and runbook | #105–#108 |

Every activation PR targets `main`; dependencies are refreshed and reverified
immediately before founder merge. No live Paperclip service, scheduler, or
Gateway credential is authorized by this extension.
