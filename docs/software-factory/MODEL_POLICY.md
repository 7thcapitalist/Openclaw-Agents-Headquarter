# Role → harness → model policy

The factory's organizational **roles** are stable. Claude / Codex / Cursor /
OpenClaw are **harnesses/models** the roles run on. Apply this policy with
`node scripts/apply-model-policy.mjs` (backs up to
`~/.openclaw/openclaw.json.before-model-policy`, idempotent, `--dry-run`), then
`openclaw daemon restart`.

| Role | Runtime agent | Harness | Primary model | Fallbacks | Why |
|---|---|---|---|---|---|
| **Chief of Staff** | `main` | OpenClaw | `openai/gpt-5.6-sol` *(default)* | `gpt-5.4-mini`, `gpt-4.1` | Orchestration / routing / decomposition. Fast and cheap — never a large model for glue work. |
| **Product** | `product` | OpenClaw | `openai/gpt-5.4-mini` | `gpt-4.1` | Normalize objective → acceptance criteria. Small, structured. |
| **Architect** | `architect` | Claude (acp) | **`anthropic/claude-sonnet-5`** | `gpt-4.1` | Design, codebase understanding, tradeoffs, large-context analysis — Claude's strength. |
| **Backend Builder** | `backend-builder` | **Codex** | *(inherits cheap default; real work is the Codex subprocess)* | — | Codex is the strong implementation harness. |
| **Frontend Builder** | `frontend-builder` | **Cursor** | *(inherits; real work is the Cursor subprocess)* | Codex | Cursor is the UI/visual-iteration harness. |
| **Reviewer** | `reviewer` | Claude (acp) | **`anthropic/claude-sonnet-5`** | `gpt-4.1` | Independent code review — different model from the builder; Claude's strength. |
| **QA** | `qa` | Claude (acp) | `github-copilot/gpt-4.1` | `gpt-5.4-mini` | Verify acceptance criteria / break the result. Kept a different harness from the builder for independence and to spread load. |
| **Security** | `security` | Claude (acp) | **`anthropic/claude-sonnet-5`** | `gpt-4.1` | Secret / injection / permission / data-loss review — Claude's strength. |
| **Release Manager** | `release` | OpenClaw | `openai/gpt-5.4-mini` | `gpt-4.1` | Deterministic gate checking. Cheap. |
| **Research** | `research` | Claude (acp) | **`anthropic/claude-sonnet-5`** | `gpt-4.1` | Discovery, source-cited briefs, difficult reasoning. |
| **Learning / R&D** | `learning` | Claude (acp) | **`anthropic/claude-sonnet-5`** | `gpt-4.1` | Analyze completed work, find patterns, propose improvements. |

## Principles

- **Claude only where it earns its cost** — design, review, security, research,
  learning. Never the default; never for routing/glue.
- **Sonnet, not Opus.** `openclaw models` shows aliases `opus`/`sonnet`; Opus stays
  opt-in per task, not a standing default (a login flow set the default to
  `claude-opus-5` once — `apply-model-policy.mjs` undoes that).
- **Copilot (`gpt-4.1`) is a fallback / bootstrap, never a primary builder.**
- **Codex builds, Cursor does UI, OpenClaw orchestrates.** Unchanged.
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
openclaw agent --agent product   -m "OK"   # -> gpt-5.4-mini / openai
```

Rollback: `cp ~/.openclaw/openclaw.json.before-model-policy ~/.openclaw/openclaw.json && openclaw daemon restart`.
