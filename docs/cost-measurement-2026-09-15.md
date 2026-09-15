# Where the money actually goes — measured 2026-09-15

Window: **2026-09-09 → 2026-09-14**, the five days of the LifeMax run.
Nothing about routing was changed. This document reports; it does not act.

## The headline, stated plainly

**The cost panel is wrong by roughly three orders of magnitude, and it is wrong
in the direction that makes the factory look free.**

| source | five-day figure |
|---|---:|
| what the cost ledger reports (`summarizeCostLedger`) | **$0.0851** |
| what the factory's agents actually consumed (token-derived) | **~$98.16** |
| interactive Claude Code in the HQ repo, same window, *not* factory dispatches | **~$377.33** |

The ledger is not slightly off. It is a **~1,150x undercount** of factory agent
spend. Anything built on the current cost panel — a budget alert, a routing
decision, a "we can afford this" — is built on a floor that reads as a total.

### Why the ledger is wrong

The ledger records **one message**, not one session. A backend-builder dispatch
on the LifeMax node records `in=410 out=349`; the Codex rollout for the same
role records `total_token_usage.input_tokens = 515,734` for a single session.
The ledger's 48 events over five days carry 78,221 input tokens in total —
against 41.4M measured on the Codex route and 843M of cache reads on the Claude
route.

PR #228 fixed this class of defect on the Anthropic route (cache token fields
were never read). The same defect is still present on the route the builders
actually run on. **This is the single highest-value fix available in the cost
area, and it is not fixed here** — see "What this PR does not fix".

## The measurement

Token counts come from the agents' own transcripts, which are the only durable
record of a full session: Codex rollouts under
`~/.openclaw/agents/<role>/agent/codex-home/sessions/` (`total_token_usage`,
cumulative per session) and Claude CLI transcripts under `~/.claude/projects/`
(per-assistant-message `usage`, deduplicated by message id). Prices are
`factory/pricing.json` rates.

### Factory agent spend by stage

| stage/role | claude $ | codex $ | total $ | share | input tok | output tok | out/in |
|---|---:|---:|---:|---:|---:|---:|---:|
| architect | 23.37 | 2.35 | **25.71** | 26.2% | 63,973,962 | 537,615 | 0.008 |
| reviewer | 13.20 | 3.96 | **17.16** | 17.5% | 41,855,755 | 305,145 | 0.007 |
| qa | 13.83 | 2.85 | **16.68** | 17.0% | 51,576,790 | 233,598 | 0.005 |
| security | 11.57 | 2.99 | **14.55** | 14.8% | 37,203,325 | 220,593 | 0.006 |
| backend-builder | 0.59 | 12.94 | **13.52** | 13.8% | 19,829,208 | 143,119 | 0.007 |
| frontend-builder | 0.07 | 6.56 | **6.63** | 6.8% | 12,893,716 | 40,476 | 0.003 |
| release | 1.75 | 0.06 | 1.82 | 1.9% | 3,925,207 | 43,434 | 0.011 |
| product | 0.00 | 1.55 | 1.55 | 1.6% | 1,366,208 | 23,766 | 0.017 |
| cursor / research / learning / workspace | 0.32 | 0.21 | 0.53 | 0.5% | 204,508 | 6,197 | — |
| **total** | **64.70** | **33.47** | **$98.16** | | | | |

**Biggest stage: `architect`, at $25.71 — 26.2% of factory spend.**
**Biggest model: `claude-opus-5`. Biggest agent: `architect`.**

### Input versus output

The brief anticipated that stages which *write* a lot would be the expensive
ones, output being 5x input. **For this workload that is inverted.** Every
stage sits between 0.003 and 0.018 output-per-input. Output is **0.6% of all
tokens**. Nothing here is expensive because it writes; everything is expensive
because it *reads*, over and over.

On the Claude route, of 858M input tokens, **843M (98.3%) are cache reads** —
the same context re-sent on every turn of a long session. The cost driver is
session length and re-read volume, not generated text.

### Unpriced spend

2 of 48 ledger events (`github-copilot/gpt-4.1`, 73,356 in / 3,814 out) have no
entry in `factory/pricing.json` and price as null. That is small **in the
ledger**, but the ledger is itself the undercount described above. Separately,
before this PR **`claude-opus-5` had no entry at all**, so the largest single
model in the real traffic priced as unpriced.

## Routing: what I changed, and what I did not

`factory.config.json` sets review selection to `different-model-from-builder`
for **independence**, not cost. The rule in the brief — never cheapen a gate —
binds here, and the measurement runs straight into it:

> **reviewer + qa + security = $48.40, 49.3% of factory spend.**
> **Adding architect: $73.05, 74.4%.**
> **Builders: $20.15. Ratio of gates+architect to builders: 3.7 : 1.**

The money is in the gates. So **I changed no routing**, and I am not proposing
a cheaper reviewer, QA or security seat. That is the founder's call, and the
honest framing is:

- The gates are not obviously *overpriced*; they are **over-run**. The prior
  session measured 2.56 gate dispatches per builder dispatch, and 11 at worst
  (`obj-842f30eb-cost-limits-data-apis`: nine reviewer runs against one build).
  Nine reviews of one build is not nine times the assurance.
- **`architect` is the largest single line and is not a gate.** It is a design
  stage. It is the one defensible routing target in this table, and it is worth
  a founder decision on its own.
- The cheapest real lever is neither: it is **session context**. At 98.3% cache
  reads, halving what a gate re-reads per turn beats any seat swap available.

Each of those is a proposal, not a change. None is made here.

## What this PR does change

Pricing correctness only — so that the next person to read a cost number is not
reading a floor:

1. **`claude-opus-5` added** to `factory/pricing.json` ($5/$25 per MTok, with
   source). It was absent, so the biggest model in the real traffic was
   unpriced.
2. **Cached-input rates added** for all three models, and the pricer now bills
   cached input at that rate instead of folding it into the full input rate.
   A model with no cached rate keeps the old behaviour deliberately — an
   unresearched model must not get a cheaper bill than it has earned.
3. **`claude-cli/*` aliases added.** The live ledger records provider
   `claude-cli`; the pricing table only knew `anthropic`.

**This does not move the historical number.** Every event in the current ledger
has `cachedInputTokens: 0`, so re-running the measurement after the change
gives the same $0.0851. The fix is forward-looking: it is correct for events
written from now on, once the capture defect below is fixed.

## What this PR does not fix

**The capture defect.** `agent-meta.mjs` extracts a per-dispatch fragment on the
Codex route rather than the session's usage. Until that is fixed, the ledger
will keep under-reporting by ~1,000x and every panel over it stays a floor.
This is a separate, larger change and it is the next thing worth doing in this
area.

Until then, **the cost panel should be read as a floor, not a total**, and it
should say so on its face.

## Caveats, on the record

- All figures are **token-derived**. No provider-reported cost was captured on
  any route in this window; it is gone and cannot be recovered.
- Codex rollouts are per **role workspace**, not per task, so the total is
  honest for five days of factory work but cannot be split cleanly between
  LifeMax and HQ.
- Sessions are windowed by file mtime. Windowing by session-start timestamp
  instead gives $27.13 rather than $33.47 on the Codex route — a ~19% swing on
  that route, ~6% on the factory total. Neither is more correct; mtime is used
  here because a session that ran across midnight belongs to the day it did the
  work.
- The **$377.33** interactive figure is what those tokens would cost at API
  rates. Claude Code seats on this machine are subscription-billed, so that is
  an opportunity cost, **not a cash figure**, and it must not be added to the
  factory total. It is reported separately for exactly that reason.
- An earlier untracked draft of this analysis (`cost-anatomy.md`) put the five
  days at **$161.58**. That figure priced all Anthropic traffic at Sonnet rates
  while roughly half of it ran on Opus 5, and it did not separate factory
  dispatches from interactive sessions. Both are corrected here.
