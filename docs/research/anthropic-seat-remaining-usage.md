# Anthropic (claude-cli) seat: is there a real remaining-usage source?

Investigated 2026-09-18 on the founder's machine, read-only. Objective:
`obj-ce696a6f-anthropic-seat-headroom`. Only sources that report **actual
remaining usage or reset time for the founder's own account** count. Cost,
token totals and inferred figures do not.

## Verdict

**Path A: a real source exists.** `claude -p "/usage"` (Claude Code 2.1.277)
prints the account's current-session and weekly usage percentages with their
reset times. It runs locally with no model call (`num_turns: 0`,
`duration_api_ms: 0`, `total_cost_usd: 0` in `--output-format json`), takes
about 4 s, and needs no credential handling by us.

## Sources checked

| # | Source | Command / location | Reports remaining usage or reset? |
|---|--------|--------------------|-----------------------------------|
| 1 | Claude CLI slash command in print mode | `claude -p "/usage"` | **Yes.** Real numbers, see below. |
| 2 | Claude CLI subcommands | `claude --help` | No dedicated usage subcommand. `claude auth status` shows login, `subscriptionType`, org; no usage. `claude doctor` is an install check. |
| 3 | Claude CLI `/status` in print mode | `claude -p "/status"` | No. Prints "isn't available in this environment". |
| 4 | `openclaw models status` (plain) | `openclaw models status` | **No for Anthropic.** Only `anthropic/claude-sonnet-5 [indeterminate]` and `anthropic via claude-cli ... status=indeterminate`. The only `usage:` line is for `openai` (`5h 18% left ⏱4h 10m · Week 20% left ⏱1d 11h`). |
| 5 | `openclaw models status --json` | same, `--json` | No. Top-level keys are `auth`, `fallbacks`, etc. No `usage` key. Anthropic appears only as `modelRouteIssues[].kind = indeterminate` and `runtimeAuthRoutes[].status = indeterminate`. |
| 6 | OpenClaw gateway usage snapshot | `openclaw status --usage` | Lists `OpenAI (plus)` windows only. No Anthropic entry, because the claude-cli seat authenticates through Claude CLI's own native auth (`synthetic: Claude CLI native auth`), so OpenClaw holds no token to query. |
| 7 | OpenClaw gateway cost summary | `openclaw gateway usage-cost` | Not usable (needs an agent id) and it is cost from session logs, which does not count. |
| 8 | OpenClaw's built-in Anthropic usage fetcher | `dist/provider-usage-*.js` (`fetchClaudeUsage`) | Code path exists (OAuth usage endpoint, or `CLAUDE_AI_SESSION_KEY` / `CLAUDE_WEB_COOKIE`), but it needs a token or web-session secret we must not read or store, and the claude-cli seat supplies none. Not used. |
| 9 | Claude CLI local session transcripts | `~/.claude/projects/*/*.jsonl` | Partial and **not usable as a headroom read**. A `quotaLimits` object (`status`, `resetsAt`, `rateLimitType`, `overageStatus`) is recorded only on a rejected 429. All 187 recorded objects have `status: "rejected"`. There is no percent-used field and no record for a healthy seat, so it says nothing about remaining usage until after exhaustion. |
| 10 | Claude CLI other local files | `~/.claude/{history.jsonl,telemetry,settings.json,...}` | No usage or percent fields found. Credential files were not opened. |

## Real output (fixture, scrubbed)

`factory/test/fixtures/claude-usage.txt` is the leading part of real
`claude -p "/usage"` output. It contains no account id, email or token.

```
Current session: 25% used · resets Sep 18, 6:30pm (America/Indiana/Indianapolis)
Current week (all models): 72% used · resets Sep 21, 5pm (America/Indiana/Indianapolis)
Current week (Fable): 0% used · resets Sep 21, 5pm (America/Indiana/Indianapolis)
```

Format facts the parser must respect:

- Values are **percent used**, not left. `percentLeft = 100 - used`.
- Reset is an **absolute local wall time with no year**, plus an IANA zone in
  parentheses. The OpenAI seat uses a relative `resetIn` string (`4h 10m`), so
  the parser converts to a duration from `now`, in the same `Nd Nh` / `Nh Nm`
  style.
- The seat `anthropic/claude-sonnet-5` maps to `Current session` (short window)
  and `Current week (all models)` (weekly). The per-model `Current week (Fable)`
  line is ignored: Sonnet 5 draws on the all-models pool.
- The rest of the output (usage-contribution breakdown) is on-machine estimate
  text and is ignored.

## Caveats

- The percentages are the account-level limits Claude Code itself shows. The
  "contributing" breakdown below them is approximate and machine-local; we do
  not read it.
- Output is human text, not a stable API. The parser must be strict and map
  anything unrecognised to `unknown`. Behaviour when logged out or already
  rate-limited was not observed, so it must be treated as unknown by
  construction, not by a guessed message.
- Use `--no-session-persistence` so the probe does not write a transcript under
  `~/.claude/projects/`. Run with a neutral cwd.
- Probing `-p "/usage"` costs no quota (no model turn). Verified `num_turns: 0`.

## Consequence for the objective

Path A. Path B artifacts (unchanged unknown, decision card) are not needed.
The inferred-availability option remains a fallback only if this output format
proves unstable, and would then need a founder decision.

## Notes for the record

- `factory/lib/idle/trigger.mjs` does not exist on this branch. It lives on the
  unmerged `factory/obj-a7b7f7b8-learning-idle-trigger` branch. This change does
  not touch it, and `unknown` stays unavailable there.
- `readPipelineCreditHeadroom` has no consumer other than its tests on this
  branch.
