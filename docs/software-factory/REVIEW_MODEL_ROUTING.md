# Review-side model routing

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
(private runtime state, not in this repo). For `architect`, `reviewer`, `qa`,
`security` it sets:

```jsonc
"models": { "github-copilot/gpt-4.1": {}, "openai/gpt-5.4-mini": {} },
"model":  { "primary": "github-copilot/gpt-4.1", "fallbacks": ["openai/gpt-5.4-mini"] }
```

`product`, `release`, `backend-builder`, `frontend-builder`, `main` are left
untouched. After this, the builder (Codex/OpenAI) and every review-side agent
(gpt-4.1 via GitHub Copilot) are different models, and the whole design + review
load leaves the OpenAI seat.

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
- This does **not** fix the underlying `runtime.acp.agent: "claude"` dispatch —
  that is a separate spike (getting the review agents onto the Claude
  subscription instead of Copilot).
