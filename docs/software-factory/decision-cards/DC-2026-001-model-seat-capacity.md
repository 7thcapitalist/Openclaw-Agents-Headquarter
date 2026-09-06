# Decision Required

## Decision
Whether to add paid model capacity for the software factory, or keep running it
on the free/existing seats with the mitigations already in place.

## Why this needs the founder
It is recurring spend on an external paid service — outside an agent's autonomy
per `AGENTS.md` and `docs/software-factory/OPERATING_RULES.md`.

## Background
Every factory agent resolves to `openai/gpt-5.6-sol` on one OAuth seat
(`grazicmm@hotmail.com`). `openclaw models` repeatedly shows the 5h usage window
near empty (9% left, week 45% left at time of writing). This one seat is the
throughput ceiling for the entire pipeline; `maxConcurrent: 4` cannot raise it.
This PR mitigates but does not remove the ceiling:
- review-side agents re-routed to `github-copilot/gpt-4.1` + `openai/gpt-5.4-mini`
  (`REVIEW_MODEL_ROUTING.md`) — spreads load, restores independence;
- reviewer + qa + security now run concurrently instead of serially.

## Option A — Second OpenAI seat / API key
- Benefit: removes the single-seat ceiling; builder + product + release get real
  headroom; independence no longer depends on Copilot.
- Cost/risk: recurring spend (a second ChatGPT/OpenAI plan, or metered API
  usage); another credential to manage in `~/.openclaw`.

## Option B — Upgrade the existing OpenAI plan tier
- Benefit: larger 5h / weekly windows on the seat already configured; no new
  credential.
- Cost/risk: recurring spend; still one seat, so a burst of parallel work can
  still starve it.

## Option C — Stay on the free/existing mitigation (no spend)
- Benefit: no new cost. The Copilot + `gpt-5.4-mini` split already takes design
  and review off the OpenAI seat; concurrency shortens wall-clock.
- Cost/risk: Copilot Student premium-request cap (~300/month) can be hit by
  heavy use; `github-copilot/gpt-4.1` auth readiness is `[indeterminate]`;
  builder/product/release still share the one OpenAI seat.

## Recommendation
**C now.** It is already in effect after this PR and costs nothing. Move to **A**
if factory build throughput becomes a priority (multiple projects, daily builds)
— a second seat is the only option that removes the ceiling rather than raising it.

## Default if no decision
C. Nothing pauses — the factory keeps running on the mitigated single-seat setup.

## Reply format
`A`, `B`, `C`, or `discuss`.
