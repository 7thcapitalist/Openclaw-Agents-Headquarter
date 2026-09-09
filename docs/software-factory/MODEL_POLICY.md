# Role → harness → model policy

The factory's organizational **roles** are stable. Claude / Codex / OpenClaw
are the active **harnesses/models** the roles run on. Each real OpenClaw agent
entry receives its own primary and fallback model chain; this is not only a
stage-routing rule. Apply this policy with
`node scripts/apply-model-policy.mjs` (backs up to
`~/.openclaw/openclaw.json.before-model-policy`, idempotent, `--dry-run`), then
`openclaw daemon restart`.

| Role | Runtime agent | Harness | Primary model | Fallbacks | Why |
|---|---|---|---|---|---|
| **Chief of Staff** | `main` | OpenClaw | `openai/gpt-5.6-sol` *(default)* | `openai/gpt-5.6-luna`, `anthropic/claude-sonnet-5`, `gpt-5.4-mini`, `gpt-4.1` | Lightweight orchestration and summaries; Luna is the cheaper first fallback, then Claude crosses the seat boundary. |
| **Objective decomposition / intake** | `architect` | Claude (acp) | **`anthropic/claude-sonnet-5`** | `openai/gpt-5.6-luna`, `openai/gpt-5.6-sol`, `gpt-4.1`, `gpt-5.4-mini` | Configurable planning calls; uses cheaper Luna before returning to the stronger Codex model. |
| **Product** | `product` | OpenClaw | `github-copilot/gpt-4.1` | `gpt-5.4-mini` | Normalize objective → acceptance criteria without relying on the shared OpenAI seat. |
| **Architect** | `architect` | Claude (acp) | **`anthropic/claude-sonnet-5`** | `openai/gpt-5.6-luna`, `openai/gpt-5.6-sol`, `gpt-4.1`, `gpt-5.4-mini` | Design, codebase understanding, tradeoffs, large-context analysis; Luna is the cheaper Codex-side fallback. |
| **Backend Builder** | `backend-builder` | **Codex** | `openai/gpt-5.6-sol` | `openai/gpt-5.6-luna`, `anthropic/claude-sonnet-5`, `gpt-5.4-mini`, `gpt-4.1` | Codex is the strong implementation harness; Luna lowers cost before Claude seat failover. |
| **Frontend Builder** | `frontend-builder` | **Codex** | `openai/gpt-5.6-sol` | `openai/gpt-5.6-luna`, `anthropic/claude-sonnet-5`, `gpt-5.4-mini`, `gpt-4.1` | Dedicated UI/product route with its own fallback chain; Cursor remains planned until its probe proves ACP support. |
| **Reviewer** | `reviewer` | Claude (acp) | **`anthropic/claude-sonnet-5`** | `openai/gpt-5.6-sol`, `gpt-4.1`, `gpt-5.4-mini` | Independent code review — different model from the builder by default; Codex is used automatically if Claude is exhausted. |
| **QA** | `qa` | Claude (acp) | `github-copilot/gpt-4.1` | `openai/gpt-5.6-sol`, `anthropic/claude-sonnet-5`, `gpt-5.4-mini` | Verify acceptance criteria / break the result; both subscription seats remain available as fallbacks. |
| **Security** | `security` | Claude (acp) | **`anthropic/claude-sonnet-5`** | `openai/gpt-5.6-sol`, `gpt-4.1`, `gpt-5.4-mini` | Secret / injection / permission / data-loss review — Claude's strength, with Codex seat failover. |
| **Release Manager** | `release` | Claude (acp) | **`anthropic/claude-sonnet-5`** | `openai/gpt-5.6-sol`, `gpt-4.1`, `gpt-5.4-mini` | Reads deterministic gate evidence and falls back to Codex if Claude is exhausted. |
| **Research** | `research` | Claude (acp) | **`anthropic/claude-sonnet-5`** | `openai/gpt-5.6-sol`, `gpt-4.1`, `gpt-5.4-mini` | Discovery, source-cited briefs, difficult reasoning, with Codex seat failover. |
| **Learning / R&D** | `learning` | Claude (acp) | **`anthropic/claude-sonnet-5`** | `openai/gpt-5.6-sol`, `gpt-4.1`, `gpt-5.4-mini` | Analyze completed work, find patterns, propose improvements, with Codex seat failover. |

## Principles

- **Claude only where it earns its cost** — design, review, security, research,
  learning. Never the default; never for routing/glue.
- **Sonnet, not Opus.** `openclaw models` shows aliases `opus`/`sonnet`; Opus stays
  opt-in per task, not a standing default (a login flow set the default to
  `claude-opus-5` once — `apply-model-policy.mjs` undoes that).
- **Copilot (`gpt-4.1`) handles small structured product work and is a fallback for larger planning/review roles, never a primary builder.**
- **Codex builds backend and UI work; Claude plans and independently checks it; OpenClaw orchestrates.**
- Every role keeps a cross-seat fallback so Claude quota exhaustion can return to
  Codex/OpenAI and Codex/OpenAI quota exhaustion can return to Claude. OpenClaw
  selects the next configured model when the provider reports quota, rate-limit,
  or availability failure; the daemon must be restarted after applying policy.
- When the fallback crosses model families, reviewer/builder model independence
  is a best-effort default rather than a guarantee during a seat outage. The
  workflow's explicit reviewer and QA gates still run and remain auditable.

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
