# Role → harness → model policy

The factory's organizational **roles** are stable. Claude / Codex / OpenClaw
are the active **harnesses/models** the roles run on. Apply this policy with
`node scripts/apply-model-policy.mjs` (backs up to
`~/.openclaw/openclaw.json.before-model-policy`, idempotent, `--dry-run`), then
`openclaw daemon restart`.

| Role | Runtime agent | Harness | Primary model | Fallbacks | Why |
|---|---|---|---|---|---|
| **Chief of Staff** | `main` | OpenClaw | `openai/gpt-5.6-sol` *(default)* | `gpt-5.4-mini`, `gpt-4.1` | Lightweight orchestration and summaries; decomposition/intake are routed separately. |
| **Objective decomposition / intake** | `architect` | Claude (acp) | **`anthropic/claude-sonnet-5`** | `gpt-4.1` | Configurable planning calls; avoids the shared OpenAI seat. Code defaults safely to `main` when optional routing keys are absent. |
| **Product** | `product` | OpenClaw | `github-copilot/gpt-4.1` | `gpt-5.4-mini` | Normalize objective → acceptance criteria without relying on the shared OpenAI seat. |
| **Architect** | `architect` | Claude (acp) | **`anthropic/claude-sonnet-5`** | `gpt-4.1` | Design, codebase understanding, tradeoffs, large-context analysis — Claude's strength. |
| **Backend Builder** | `backend-builder` | **Codex** | *(inherits cheap default; real work is the Codex subprocess)* | — | Codex is the strong implementation harness. |
| **Frontend Builder** | `frontend-builder` | **Codex** | *(inherits; real work is the Codex subprocess)* | — | Dedicated UI/product route; Cursor remains planned until its probe proves ACP support. |
| **Reviewer** | `reviewer` | Claude (acp) | **`anthropic/claude-sonnet-5`** | `gpt-4.1` | Independent code review — different model from the builder; Claude's strength. |
| **QA** | `qa` | Claude (acp) | `github-copilot/gpt-4.1` | `gpt-5.4-mini` | Verify acceptance criteria / break the result. Kept a different harness from the builder for independence and to spread load. |
| **Security** | `security` | Claude (acp) | **`anthropic/claude-sonnet-5`** | `gpt-4.1` | Secret / injection / permission / data-loss review — Claude's strength. |
| **Release Manager** | `release` | Claude (acp) | **`anthropic/claude-sonnet-5`** | `gpt-4.1` | Reads deterministic gate evidence and avoids stranding green tasks on the shared OpenAI seat. |
| **Research** | `research` | Claude (acp) | **`anthropic/claude-sonnet-5`** | `gpt-4.1` | Discovery, source-cited briefs, difficult reasoning. |
| **Learning / R&D** | `learning` | Claude (acp) | **`anthropic/claude-sonnet-5`** | `gpt-4.1` | Analyze completed work, find patterns, propose improvements. |

## Principles

- **Claude only where it earns its cost** — design, review, security, research,
  learning. Never the default; never for routing/glue.
- **Sonnet, not Opus.** `openclaw models` shows aliases `opus`/`sonnet`; Opus stays
  opt-in per task, not a standing default (a login flow set the default to
  `claude-opus-5` once — `apply-model-policy.mjs` undoes that).
- **Copilot (`gpt-4.1`) handles small structured product work and is a fallback for larger planning/review roles, never a primary builder.**
- **Codex builds backend and UI work; Claude plans and independently checks it; OpenClaw orchestrates.**
- Every role keeps a fallback so no stage hard-fails on one provider's rate limit.

## Context / sessions

A stage receives a **structured handoff** (`factory/lib/handoff.mjs`
`writeHandoff`), not a transcript: role prompt + assembled factory/project
context (`assembleContextPack`) + acceptance criteria + one-line summaries of
prior passed stages + returned findings + the machine result contract. Each
dispatch gets a **fresh session** keyed `agent:<id>:factory-<taskId>-<stage>-<attempt>`,
so context never accumulates across stages or tasks. The long-lived
`agent:main:main` session is the only persistent one.

## Verify

```bash
openclaw agent --agent reviewer  -m "OK"   # then: openclaw sessions --agent reviewer
#   -> model claude-sonnet-5 / provider anthropic / runtime claude-cli
openclaw agent --agent product   -m "OK"   # -> gpt-4.1 / github-copilot
```

Rollback: `cp ~/.openclaw/openclaw.json.before-model-policy ~/.openclaw/openclaw.json && openclaw daemon restart`.
