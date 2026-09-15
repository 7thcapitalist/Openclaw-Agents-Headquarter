# Cost anatomy — where the money actually goes

**Measured 2026-09-15. Nothing was changed: no routing, no prompts, no config.**
Window: 2026-09-09 → 2026-09-14, the five days of the LifeMax run.

---

## The answer

**The 96:1 ratio is not real. It was an artifact of two broken usage-capture paths, and the true ratio is about 7:1.** The $1.19 builder figure came from the same class of defect PR #228 fixed on the Claude route, still present on the Codex route the builders actually run on: the ledger records a per-dispatch fragment rather than the session's real usage. Replaying Codex's own rollout transcripts puts the builders at **$19.50**, not $1.19 — a 16× undercount — and the five days at **~$161.58** rather than $128.11. Against that, the four gate-and-design stages (architect, reviewer, qa, security) cost **$134.87**, so the real split is roughly **7:1, not 96:1**. Seven-to-one is still lopsided and worth acting on, but it is a different problem from the one the broken number implied: it is not that building is free, it is that **review runs 2.56 times per build on average and 11 times at worst**, and every one of those runs is a full-context agent call.

---

## 5a. Is the number real? No.

### The defect, in the same shape as the Claude one

`agent-meta.mjs` extracts usage from whatever the harness hands back. PR #228 fixed the Anthropic side (cache tokens were never read). The Codex side was never examined, and it is wrong in a different way: the ledger's openai events record numbers far too small to be a session.

Ledger, by provider, over all 48 events:

| provider/model | events | input | cached | output |
|---|---:|---:|---:|---:|
| `openai/gpt-5.6-sol` | 28 | 4,829 | **0** | 3,265 |
| `claude-cli/claude-sonnet-5` | 18 | 36 | **0** | 38 |
| `github-copilot/gpt-4.1` | 2 | 73,356 | 0 | 3,814 |

Individual builder dispatches on the LifeMax backend node record `in=410 out=349` and `in=425 out=375`. That node produced **61 files and +15,043 lines across 36 attempts**. Those numbers are not a session; they are one message.

The `github-copilot` row is the tell: at 73,356 input tokens over 2 events, that route captures something realistic. So this is not "the factory cannot measure" — it is that **two of the three routes extract the wrong field**.

### What Codex actually recorded

Codex writes rollout transcripts to `~/.openclaw/agents/<role>/agent/codex-home/sessions/`, and they carry real usage:

```json
{"total_token_usage":{"input_tokens":19622,"cached_input_tokens":9344,
 "output_tokens":191,"reasoning_output_tokens":68,"total_tokens":19813}}
```

`total_token_usage` is cumulative per session; `input_tokens` already includes the cached portion. Replaying 258 rollout files, 46 of them inside the window, priced at `factory/pricing.json`'s gpt-5.6-sol rates ($4/M in, $20/M out) with cached input at OpenAI's 10%:

| role | sessions | input | cached | output | USD |
|---|---:|---:|---:|---:|---:|
| backend-builder | 12 | 18,858,959 | 18,080,256 | 129,428 | **$12.94** |
| frontend-builder | 2 | 12,868,692 | 12,694,528 | 39,327 | **$6.56** |
| reviewer | 5 | 5,987,938 | 5,732,736 | 32,269 | $3.96 |
| security | 6 | 4,046,457 | 3,823,488 | 28,270 | $2.99 |
| qa | 6 | 5,258,094 | 5,167,360 | 21,196 | $2.85 |
| architect | 4 | 2,855,948 | 2,657,152 | 24,359 | $2.35 |
| product | 3 | 1,366,208 | 1,218,944 | 23,766 | $1.55 |
| cursor / release / research | 8 | 102,277 | 47,488 | 1,857 | $0.27 |
| **Codex total** | **46** | | | | **$33.47** |

**Builders: $19.50.** The ledger said $1.19.

### The corrected five days

| route | cost |
|---|---:|
| Claude CLI (from PR #228's replay) | $128.11 |
| Codex / OpenAI (this replay) | $33.47 |
| **total** | **~$161.58** |

| grouping | cost |
|---|---:|
| builders (backend + frontend, Codex) | **$19.50** |
| architect + reviewer + qa + security (both routes) | **$134.87** |
| **ratio** | **6.9 : 1** |

Both figures are **token-derived**. Provider-reported cost was never captured on any route and is gone.

**Caveat I want on the record:** the Codex rollouts are per *role workspace*, not per task, so this is an honest total for five days of factory work but cannot be split cleanly between LifeMax and HQ. The same limitation applied to the Claude replay, where 89% of sessions referenced both projects.

---

## 5b. Fan-out

Dispatches per stage, per task, from the durable `state.dispatches` record.

**Average: 2.56 reviewer+qa+security dispatches per builder dispatch.** 50 builder dispatches produced 128 gate dispatches across 20 tasks.

**Worst: `obj-842f30eb-cost-limits-data-apis` at 11.00** — 9 reviewer + 1 qa + 1 security for a *single* builder dispatch. The reviewer ran nine times against one build.

| task | prod | arch | bld | rev | qa | sec | rel | gate/bld |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| obj-842f30eb-cost-limits-data-apis | 1 | 1 | 1 | **9** | 1 | 1 | 1 | **11.00** |
| obj-c58897c0-game-frontend | 4 | 1 | 1 | 5 | 1 | 1 | 1 | 7.00 |
| obj-842f30eb-cost-limits-today-panel | 1 | 1 | 1 | 5 | 1 | 1 | 1 | 7.00 |
| obj-cfd7dd51-add-health-module | 1 | 1 | 1 | 1 | 3 | 1 | 1 | 5.00 |
| obj-cfd7dd51-integration | 1 | 1 | 2 | 7 | 2 | 0 | 0 | 4.50 |
| obj-039f0f5a-deployment-capability-core | 1 | 1 | 4 | 3 | 6 | **7** | 0 | 4.00 |
| task-ca3c3cdf | 4 | 4 | 1 | 4 | 0 | 0 | 0 | 4.00 |
| obj-c58897c0-game-backend | 1 | 1 | **11** | 7 | 12 | 2 | 2 | 1.91 |

Factory-wide, 264 dispatches: reviewer **65**, builder **50**, qa **40**, product 31, architect 29, release 26, security 23.

**The reviewer is the single most-dispatched stage in the factory — more than the builder.**

A second thing this exposes: `obj-039f0f5a` ran **7 security dispatches against a stated limit of 3**, and its qa ran 6. The per-stage budget is not what `maxAttempts` claims.

---

## 5c. Context budget — the packs are small, and the giant one was a single node

Measured across **139 real handoff files** on disk. (~4 bytes/token.)

| stage | files | median | max | ~median tokens | ~max tokens |
|---|---:|---:|---:|---:|---:|
| product | 22 | 9,210 B | 31,422 B | 2,303 | 7,856 |
| architect | 21 | 10,013 B | 31,673 B | 2,503 | 7,918 |
| builder | 21 | 11,568 B | 34,684 B | 2,892 | 8,671 |
| reviewer | 20 | 11,978 B | 32,472 B | 2,995 | 8,118 |
| qa | 20 | 13,183 B | 32,660 B | 3,296 | 8,165 |
| security | 20 | 13,099 B | 32,293 B | 3,275 | 8,073 |
| release | 15 | 14,274 B | 22,696 B | 3,569 | 5,674 |

**Do reviewer, qa and security get the same giant pack as the builder? They get the same pack — but it is not giant.** Every stage sits in a narrow 2,300–3,600 median token band. The gate stages get marginally *more* than the builder (3,000–3,300 vs 2,892), which is the accumulated prior-stage summaries, not a different pack.

**This is the most important finding in this section: the handoff is not where the context size comes from.** The forensics measured live reviewer-adjacent sessions holding **133k–162k tokens** against handoffs of **~3k**. The other ~98% is the agent's own session accumulation — file reads, tool output, its own turns — not anything the factory hands it. Shrinking the handoff would change almost nothing.

Composition of the largest pack (`obj-c58897c0-integration`, builder, 34,684 B):

| section | bytes | share |
|---|---:|---:|
| **Outcome** | **22,427** | **65.2%** |
| Project context: LifeMax | 4,046 | 11.8% |
| Returned findings | 2,277 | 6.6% |
| Machine result contract | 1,095 | 3.2% |
| everything else | 4,839 | 13.2% |

**Was the embedded 1,307-line mission the general pattern? No — it was that one node.**

Across all 139 handoffs the Outcome section is a **median of 164 bytes**, p90 **312 bytes**, max **22,427**. Exactly **6 of 139** exceed 15,000 bytes, and all six are the six handoffs of `obj-c58897c0-integration`. The integration node embedded the whole mission in its `outcome` for what was a merge-and-verify job; no other node did.

---

## 5d. Crossover

**Assumptions, stated plainly:**
- Blended cost per dispatch = $161.58 ÷ 264 dispatches = **$0.612**. This is an average across stages and both routes; a reviewer dispatch costs more than a release one, so this smooths real variance.
- A "bounded task" = one endpoint or component, ~200 lines, acceptance criteria naming one test command. Modelled as **7 dispatches**: product, architect, builder, release, plus 2.56 gate dispatches rounded to 3 — which is also the first-time-through floor.
- Pricing per `factory/pricing.json` at 2026-09-08 rates.

| | dispatches | cost |
|---|---:|---:|
| one bounded task | 7 | **~$4.28** |
| 10 bounded tasks | 70 | ~$42.84 |
| 20 bounded tasks | 140 | ~$85.69 |
| **30 bounded tasks** | **210** | **~$128.53** |
| 40 bounded tasks | 280 | ~$171.37 |
| **the 2 LifeMax nodes, actual** | **50** | **~$30.60** |

`obj-c58897c0-game-backend` alone was 36 dispatches (~$22.03); `-game-frontend` 14 (~$8.57).

**Do 30 small tasks cost more or less than 2 large ones? Substantially more — about 4.2×.** $128.53 against $30.60.

**The crossover is at ~7 bounded tasks.** Two large nodes cost the same as 7.1 small ones. Decomposing the LifeMax objective into the 28 workstreams its own text asked for would have cost roughly four times what the 2-node decomposition did.

**But cost is not the only axis, and this arithmetic does not settle the decomposition question.** The 2-node run took five days, produced 36 and 14 attempts, and left an integration node that livelocked. The per-dispatch cost of a small task is the same; what changes is that a small task is far more likely to pass its gates first time — the worst fan-out in the data (11.00) was a *large* ambiguous task, and the 3.00-ratio tasks at the bottom of the fan-out table are the small ones that passed cleanly. A model where small tasks hit the 7-dispatch floor and large ones average 25 would move the crossover a long way. I do not have enough completed small tasks in this dataset to measure that, and I am not going to assume it.

---

## Recommendations

1. Fix the Codex usage extraction the way PR #228 fixed the Claude one — read `total_token_usage` from the rollout, not the per-message fragment.
2. Record `projectId` on every cost event at write time, so spend can be split per project without replaying transcripts.
3. Cap reviewer dispatches per builder commit — 9 reviews of one unchanged build is the single largest waste in the data.
4. Make the per-stage attempt budget actually bind; `obj-039f0f5a` ran 7 security dispatches against a stated limit of 3.
5. Stop embedding an objective's full text in a node's `outcome`; it affected one node, and that node is the one that livelocked.
6. Do not decompose for cost — decompose for gate-pass rate, and measure that before committing to it.

*Measure-only pass. No routing, prompt or configuration was changed.*
