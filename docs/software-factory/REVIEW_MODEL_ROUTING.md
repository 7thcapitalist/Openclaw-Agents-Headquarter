# Review-side model routing

> Historical routing note. The current policy is
> [`MODEL_POLICY.md`](MODEL_POLICY.md); active frontend work is Codex-backed,
> and `scripts/probe-cursor-harness.mjs` remains the authority on whether Cursor
> can be promoted from a planned harness.

## Why

Every factory agent resolves to `openai/gpt-5.6-sol` on one OAuth seat
(`grazicmm@hotmail.com`). Two problems follow:

1. **No independence.** `docs/software-factory/OPERATING_RULES.md` requires the
   reviewer to be a *different model* from the builder. The builder runs on
   Codex/`gpt-5.6-sol`; `architect`/`reviewer`/`qa`/`security` are configured for
   `runtime.acp.agent: "claude"` but that dispatch is not wired to the installed
   `claude` CLI — they silently fall back to the same Codex/`gpt-5.6-sol`. So
   builder == reviewer today.
2. **One seat is the ceiling.** `openclaw models` regularly shows the 5h window
   near empty (9% left when this was written). `maxConcurrent: 4` cannot help —
   the seat, not concurrency, is the limit.

## What the script changes

`scripts/apply-review-model-routing.mjs` edits `~/.openclaw/openclaw.json`
(private runtime state, not in this repo).

| Agents | primary | fallbacks | effect |
| --- | --- | --- | --- |
| `architect`, `reviewer`, `qa`, `security` | `github-copilot/gpt-4.1` | `openai/gpt-5.4-mini` | different model from the builder; design+review load leaves the OpenAI seat entirely |
| `product`, `release` | `openai/gpt-5.4-mini` *(unchanged)* | `github-copilot/gpt-4.1` | the pipeline can still **start** (`product` is stage 1 and had no fallback) and **finish** during an OpenAI cooldown |

Each `model` becomes the object form `{ primary, fallbacks }` and every ref is
registered in the sibling `models` map. `main`, `backend-builder`,
`frontend-builder` inherit `agents.defaults.model`, which already carries the
`github-copilot/gpt-4.1` fallback — untouched.

## Run / revert

```bash
node scripts/apply-review-model-routing.mjs --dry-run   # show the diff, write nothing
node scripts/apply-review-model-routing.mjs             # back up, then apply
openclaw daemon restart                                 # reload

# undo:
node scripts/revert-review-model-routing.mjs
openclaw daemon restart
```

The first apply copies the config to `~/.openclaw/openclaw.json.before-review-routing`;
subsequent applies keep that earliest baseline. The script is idempotent.

## Verify

```bash
openclaw agent --agent reviewer --session-key "route-check-$(date +%s)" -m "PROBE_OK"
openclaw sessions --agent reviewer          # newest row: runtime "OpenClaw", model "gpt-4.1"
```

Before the change that row reads runtime "OpenAI Codex", model "gpt-5.6-sol".

## Caveats

- **Copilot Student premium-request cap** (~300/month). One concurrent review
  phase = 3 calls (reviewer + qa + security). Fine for occasional builds; not for
  high-volume automation. If throughput becomes a priority, see
  `decision-cards/DC-2026-001-model-seat-capacity.md`.
- `openclaw models` currently reports `github-copilot/gpt-4.1` as
  `[indeterminate]` auth readiness. In practice it serves `main` / `research` /
  `learning` today; the `openai/gpt-5.4-mini` fallback covers a miss.
- This does **not** put the review agents on the Claude *subscription* — see
  below.

## ACP / acpx root cause (why "claude" agents run on OpenAI)

`architect`/`reviewer`/`qa`/`security` are configured with
`runtime.acp.agent: "claude"`, `backend: "acpx"`. But
`~/.openclaw/openclaw.json` `plugins.entries.acpx.config.agents` maps **only
`cursor`** to a command:

```jsonc
"acpx": { "config": { "agents": {
  "cursor": { "command": "/home/joao-vitor/.local/bin/cursor-agent", "args": ["acp"] }
} } }
```

There is no `claude` (or `codex`) entry, so acpx has nothing to spawn for
`agent: "claude"` and the turn silently falls back to the OpenAI seat. It cannot
be wired the way `cursor` is: **`claude` (Claude Code) has no `acp` subcommand**
— it is not an ACP server. Putting these agents on the Claude subscription needs
OpenClaw's `anthropic` provider (interactive `openclaw models auth` login) or
Anthropic API credit. That is a spend/effort decision — see
`decision-cards/DC-2026-001-model-seat-capacity.md`. The no-spend answer is the
`github-copilot/gpt-4.1` routing above. `npm run factory:doctor` flags this gap.
