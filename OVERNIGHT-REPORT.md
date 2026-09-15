# Overnight run — what you can do at 8am

**Console:** https://openclaw-agents-headquarter.vercel.app — signed in and verified on production, not a preview.
**Screenshots:** `~/hq-console-screenshots/` — 14 files, every tab at 375px and desktop.

Everything below was merged to production and checked signed-in through the real login.
`HQ_AUTO_RETRY=0` throughout. All four pm2 services online. 1,613 tests green.

---

## The list, answered honestly

### 1. See instantly whether anything needs me, and answer it there, and see it take — **TRUE**

And the dead click is solved. It was **enqueued and claimed**, then failed with a true reason:

> `"Task is not waiting for a founder decision."`

Two identical intents, 239ms apart — one click, fired twice. The refusal was correct and **the card was the bug**: `deriveTaskDecisions` filtered on the blocker alone and never checked task status, so `task-ca3c3cdf`, closed at 00:10, went on offering its options forever.

Fixed both halves. Terminal tasks no longer advertise decisions, and an answer now shows a persistent state — *Sending → Sent, waiting for the machine → Done or the machine's verbatim refusal* — that names the staleness ("nothing has been applied until this says so") and survives the next publish. A second press while queued is ignored.

**Right now the honest answer is that nothing needs you.** Zero decisions are waiting: the other one was resolved, and the two remaining blocked tasks carry `fail`, not `decision-required`.

### 2. Everything the factory has done, in time order, with which agent and when — **TRUE**

The console had no version of this at all. It does now: *when · which agent · what it did · to which work by name*.

The real ceiling was not the feed limit — each task view carried only its **last 5 events**, so the whole factory could offer 105 no matter what was asked for.

| | before | after |
|---|---:|---:|
| events per task | 5 | 40 |
| pool available | 105 | **778** |
| published | 30 | **200** |
| carrying an agent | — | 185 |

The local panel also rendered 10 of the 30 it was handed and **dropped `actor` entirely**. Both fixed.

### 3. Every task, where it sits, and open any to the full stage view — **TRUE**

The Board was **empty, not seeded** — it read a 3-byte `tasks.json` and showed zero in all six columns while 21 tasks ran. It now reads the live pipeline, on **both** surfaces, from one shared mapping file.

Inbox 0 · Assigned 1 · In Progress 1 · Review 2 · Done 14 · Blocked 3

Reviewer/qa/security collapse into one **Review** column; **Blocked outranks stage**. Tapping any card opens the ported **Task execution** sheet: seven stages, the agent per stage, attempts against the limit, evidence paths, and why it stopped.

### 4. My projects and what is happening in each — **TRUE**

Projects tab: running / blocked / waiting-on-me counts, spend, deploy state. Tapping one filters the Board to it.

### 5. Every agent, what it is on, and which model it really runs — **TRUE**

All 12 resolve. Shows `harness → seat`, e.g. `codex → openai/gpt-5.6-sol (configured)` — the field that already misled you once when config said Cursor and it really ran on Codex.

### 6. What finished, what it cost, and open what it produced — **PARTLY TRUE**

Deliveries tab: 14 deliverables, each named by outcome, with cost, PR link, and one tap to its execution record.

**What is missing:** preview links. No deployment record is written when a task finishes and no project declares a URL, so the card says so once under the list rather than rendering a dead link. **The proposer's suggestion is shown but is read-only** — it says so on the card rather than offering a button that cannot work.

### 7. Hand the factory new work, now or for tonight — **NOT YET**

Launch does not exist on the console. Starting an objective spends real money unattended and needs the confirm-back flow plus two new intent kinds (`objective.start`, `overnight.*`), of which **9 of 12 remain unhandled**. I left it rather than ship a half-built money-spending button.

### 8. What it is costing me, and whether the machine is healthy — **PARTLY TRUE**

Cost is on Today and correct: `$0.09 across all 48 recorded runs · 2 runs have no price yet, so this is a floor`. It names its window instead of implying "today", and admits when it is a floor.

**What is missing:** `/api/system/readiness` exists, works, and still has no console surface. `buildReadinessReport` needs the dashboard's SQLite and `factory/` must not import from `dashboard/`, so it needs a small factory-side equivalent rather than a wire-up.

---

## Merged tonight

| PR | What |
|---|---|
| #236 | Dead click: terminal tasks stop advertising decisions; answers show a real state |
| #239 | Activity: 105 → 778 pool, 200 published, agent shown |
| #241 | Board on real tasks, both surfaces; console gets tabs |
| #242 | Ported Task execution view |
| #243 | Deliveries with cost, PR links and the proposer |
| #244 | The console shows what the factory has done |

## Three defects found by looking at screens rather than code

1. **`.home { display: flex }` out-specified `[hidden]`** — switching tabs stacked Home's content above the tab's. `[hidden] { display: none !important }` was simply missing.
2. **The local dashboard issues no session cookie over plain http** — 200 with no `Set-Cookie`. It needs `X-Forwarded-Proto` the way the tunnel provides it.
3. **Cards named their stage twice** — "Blocked at preparing delivery · Preparing delivery 7/7".

## Still open, honestly

- **Launch** (item 7) — the one thing I deliberately did not build.
- **Readiness on the console** (item 8).
- **Deployment records** — blocks every preview link.
- **Money / Governance / Engine tabs** — still the local dashboard's Today, which remains crowded.
- **SOPs / Runs / Logs / Reports** — not yet retired; they still show empty or wrong-database content.
- **`data/hq/tasks.json`** — the Board no longer reads it, but the file and `seed:hq` are still there and still misleading.

## State of the machine

```
publishedAt  2026-09-15T07:18:13Z     8 panels     166,542 bytes = 3.97% of cap
activity 200 · tasks 21 · agents with a seat 12 · decisions waiting 0
publish-on-change: floor 30s, heartbeat 5m — confirmed publishing on schedule
HQ_AUTO_RETRY=0 · hq-tunnel, hq-dashboard, hq-publisher, hq-intents all online
```
