# Console architecture — inventory, coverage, and one proposed IA

**Written 2026-09-15. Proposal only. Nothing was built, changed, merged or deployed.**

Two surfaces exist:

- **Local dashboard** — `dashboard/backend/`, Express + vanilla JS, 8 tabs, 82 API routes, reached over the Tailscale tunnel.
- **Hosted console** — `control-plane/`, static + 4 Vercel functions, reads one published snapshot blob plus per-task blobs.

---

## The headline

**Most of what you asked for already exists and is either broken, empty, or unreachable from where you are.** Of 23 surfaces inventoried, **7 are real and working**, **6 are real but incomplete**, **5 render nothing at all**, and **5 are capabilities with no UI**. The work list in Part 4 comes out at **60% repair, 25% reorganisation, 15% genuinely new**.

Three specific things are worse than reported:

1. **The Task Board is not showing "seeded demo data".** `tasks.json` is **3 bytes** — an empty array. It shows zeros because there is nothing in it *and* the banner claims example data that does not exist either.
2. **Runs and Logs read a different database from the factory.** `agent_runs` has **1 row**; the factory's real record (1,272 events across 21 tasks) is in `dashboard/backend/data/factory/`, which those tabs never touch.
3. **The activity history you rely on is already in the hosted snapshot** — 30 records, 14,761 bytes, 0.35% of the cap — and simply is not rendered. No endpoint needed.

---

# PART 1 — INVENTORY

## Local dashboard

| Surface | Question it answers | Data source | Real? | Interactive? | Reachable? |
|---|---|---|---|---|---|
| **Today** (`renderToday`) | What needs me, and what is the company doing? | `/api/founder/overview` + 15 more routes — real factory state | **REAL** | yes — works | yes, default tab |
| ├ Needs You / founder inbox | What is waiting on me? | `/api/founder/approval-key`, `/api/founder/approvals/*` | **REAL** | yes — approve/reject/dismiss work | yes |
| ├ Objective portfolio | What did I send, and where is it? | `/api/founder/objectives` | **REAL** | yes — archive/unarchive, drill-down | yes |
| ├ **Recent activity** | What just happened, in order? | `state.activityFeed` ← `buildActivityFeed` | **REAL** but truncated to 10 of 30, and **drops the `actor` field it is given** | no | yes |
| ├ Outcome launcher | Where do I hand the factory work? | `POST /api/founder/intake` | **REAL** | yes — works | yes |
| ├ Overnight queue | What runs tonight? | `/api/founder/overnight*`, own SQLite store | **REAL** | yes — add/remove/start/stop | yes |
| ├ Search | Where is that thing? | `/api/hq/search` | **REAL** | yes | yes |
| ├ Cost & limits | What am I spending? | `/api/hq/costs`, `/api/hq/plan-limits` | **REAL** — now correct after the ledger fix | no | yes |
| ├ Goals / Proposals / Autonomy / Learning / Blind spots | assorted | `/api/hq/*` | **REAL** | mostly no | yes |
| ├ Budgets · Permissions · Blast radius · Retention · Scorecards · Deployments | assorted | `/api/hq/*` | **REAL** | no | yes — all crammed onto Today |
| **Agents** (`renderAgents`) | Who works here and what are they on? | `loadCompany()` + `/api/agents` + `/api/hq/role-policy` | **REAL** | drill-down to agent detail | yes |
| **Projects** (`renderProjects`) | What projects exist? | `loadCompany()` — real registry | **REAL** | click to project detail | yes |
| **Project detail** (`renderProject`) | How is this project doing? | cached company state | **REAL** | drill-downs | yes |
| **Task Board** (`renderTasks`) | Where does each piece of work sit? | `/api/hq` → `tasks.json` | **EMPTY — 3-byte file.** Six columns, all zero, while 21 real tasks exist. Banner claims seeded example data that also does not exist | "Edit tasks JSON" — edits an empty file nothing reads | yes |
| **SOPs** (`renderSops`) | What are our operating procedures? | `sops.json` | **EMPTY — 3 bytes** | "Edit SOPs JSON" | yes |
| **Logs** (`renderLogs`) | What did the agents output? | `/api/runs` → `agent_runs` | **NEAR-EMPTY — 1 row.** Wrong database: the factory writes elsewhere | no | yes |
| **Reports** (`renderReports`) | What did we deliver? | `/api/hq/reports` → `reports.json` | **EMPTY — 3 bytes.** The real per-task reports live at `/api/founder/tasks/:id/report`, which this tab does not call | no | yes |
| **Runs** (`renderRuns`) | What executed? | `/api/runs` → `agent_runs` | **NEAR-EMPTY — 1 row.** Same wrong database | click to run detail | yes |
| **Run detail** (`renderRunDetail`) | What happened in that run? | `/api/runs/:id` | near-empty | no | yes |
| **Agent detail** (`renderLabAgent`) | What is this agent's workspace? | `/api/agents/:p/:id`, `/api/admin/...` | **REAL** (Agent Lab) | workspace file edit | yes |
| **Task execution modal** | How is this one task going, stage by stage? | `/api/founder/tasks/:id/execution` + timeline + interactions | **REAL — and the best screen in the product** | comment thread, retry | yes, from Today |
| **Report drill-down** | What did this deliverable produce? | `/api/founder/{objectives,tasks}/:id/report`, `/evidence` | **REAL** | no | yes, from Today |
| **Approval flow** | Do I authorise this high-risk build? | `/api/founder/approvals/:taskId/{prepare,submit,reject,rekey}` | **REAL — Ed25519 signing** | yes | yes, from Needs You |

## Hosted console

| Surface | Question | Source | Real? | Interactive? | Reachable? |
|---|---|---|---|---|---|
| **Home** | Does anything need me? | snapshot blob | **REAL** | decision buttons enqueue intents | yes |
| Everything-else fold | (legacy panels) | snapshot | REAL | no | yes, collapsed |
| Per-task detail | *(published, 21 blobs)* | `mirror/tasks/<id>.json` | **REAL — but nothing renders it yet** | — | **NO UI** |

## API routes with no UI caller

82 routes; **~25 genuinely orphaned**. Classified:

### Working capability nobody exposed — keep and wire

| Route | What it is |
|---|---|
| `GET /api/hq/projects/:id/deployment` | Per-project deploy state. Phase 5's missing link. |
| `GET /api/hq/projects/:id/profile` | Project profile/context. |
| `PUT /api/hq/projects/:id` | Edit a project. |
| `POST /api/founder/projects` | **Register a new project from the UI.** Today you edit `factory/projects.json` by hand. |
| `POST /api/founder/projects/:id/:action` | Project lifecycle actions. |
| `GET /api/system/readiness` | Whole-system readiness report — would have shown the blob store was down. |
| `GET /api/hq/agents` | Agent roster with lifecycle. Duplicates part of `/api/hq`. |
| `GET /api/hq/projects` | Project registry. |
| `POST /api/founder/objectives/:id/retry` | Retry an objective. Wired in the *intent* worker but not the local UI. |
| `POST /api/founder/decisions/approve` | Signed approval by file path — the CLI path, no UI. |

### Dead weight — propose removing

| Route | Why |
|---|---|
| `GET /api/command-center/home` | Superseded by `/api/founder/overview`; builds cards from the near-empty `agent_runs`. |
| `GET /api/hq/command-center` | Second superseded command-center builder. |
| `GET /api/overview` | Third. Pre-factory Agent Lab overview. |
| `GET /api/outputs/cards` | Agent Lab output cards; nothing reads them. |
| `GET /api/agents/:p/:id/outputs/latest`, `/markdown`, `/logs` | Agent Lab file browsing, superseded by evidence + the execution modal. |
| `GET/PUT /api/agents/:p/:id/workspace/:file` | Remote workspace file editing. Real capability, but it is an arbitrary-file editor on a founder-facing surface. |
| `GET /api/command-center/health` | Shells out to `openclaw health` on every call. |

### UI that calls nothing

- **Task Board**, **SOPs**, **Reports** "Edit … JSON" buttons — edit empty files nothing reads.
- `renderProjects` / `renderProject` / `renderObjectivePortfolio` make no calls of their own; they render `loadCompany()` cache. Fine, not a defect.

---

# PART 2 — THE VIEW THAT EXISTS ON ONE SURFACE ONLY

## What it is called

**"Recent activity"** — a panel on the **Today** tab, eyebrow *"Machine events"*, subtitle *"raw workflow events"*. `dashboard/backend/public/app.js:417-423`.

Its companion is the **objective portfolio's HISTORY group** (`renderObjectivePortfolio`, grouped ACTIVE / HISTORY / ARCHIVED) — that is the "everything I sent to the factory" half; Recent activity is the "what progressed, who acted, when" half. **Together** they are the view you described. Neither is complete alone.

## What backs it

| | |
|---|---|
| Route | `GET /api/founder/overview` → `state.activityFeed` |
| Builder | `buildActivityFeed(tasks, { limit: 30 })` — `factory/lib/hq/activity.mjs:177` |
| State | every task's `state.events[]`, flattened, sorted newest-first, capped at 30 |
| Fields | `at, type, stage, actor, outcome, direction, taskId, project, objective` |
| Truth available | **1,272 events across 21 tasks; 1,086 carry an actor** |

**Two defects in the local view itself:** it renders only **10 of the 30** it is handed, and it **drops `actor`** — the "which agent acted" you asked for is in the data and not on the screen.

## What it would take on the console

**Nothing new. The data already crosses the boundary.**

| | |
|---|---|
| Already in the snapshot? | **Yes** — `panels.company.activityFeed`, 30 records |
| Size today | **14,761 bytes = 0.35% of the 4 MiB cap** |
| Per record | 492 bytes |
| Full 1,272-event history if published | ≈229 KB = **5.5% of cap** |
| Needs its own endpoint? | **No.** Unlike per-task detail, this is small, global, and changes on the same cadence as everything else |

So the console gap is **purely a rendering gap**. Raising the cap from 30 to, say, 200 events costs ~84 KB (2% of cap) and gives real history. Publishing all 1,272 is affordable but unnecessary; 200 with "older on the machine" is the right trade.

**This is the template.** For every screen the question is: *where does it exist, does it work, can I reach it from where I am.*

---

# PART 3 — ONE ARCHITECTURE

Organised by **how often you need it**, not by how the system is built.

## Daily — one click

### 1. `Today`
**Question: what needs me right now, and what just happened?**
Decision queue (answer in place) → what is stuck → **what finished recently** (name, cost, PR, preview, one-click next step) → **Activity** (the Part 2 view, with the agent named) → one pulse line.
*Both surfaces. Same name, same order.*

### 2. `Board`
**Question: where does every piece of work sit right now?**
Six columns on **real factory tasks**. Proposed mapping — say if you disagree:

| Column | Factory state |
|---|---|
| Inbox | created, `product` not yet passed |
| Assigned | `product`/`architect` in flight |
| In Progress | `builder` in flight |
| **Review** | `reviewer`, `qa` **or** `security` in flight — *these three are one gate to you; splitting them into three columns would make the board unreadable* |
| Done | `merge-ready`, `merged` |
| Blocked | `status: blocked` or `failed`, **regardless of stage** — blocked outranks position |

*Both surfaces.*

### 3. `Launch`
**Question: how do I hand the factory work, now or tonight?**
Outcome box + project picker + "Start an outcome"; "Plan the night" with the overnight queue.
*Both surfaces — console writes via the intent protocol.*

> **Defect, found 2026-09-15 — the launcher is silent for half a minute and loses the launch.**
> `#founder-command`'s submit handler (`app.js:1029`) POSTs `/api/founder/intake` and awaits it
> before it ever calls `launch()`. Intake is a live model call taking 15-40s, and nothing on
> screen changes while it runs: the button stays enabled, there is no spinner, no pending state.
> A working launch and a broken one look identical, so the founder clicks again.
>
> It cost a real launch. Eleven intake calls ran against the Lifemaxing objective between
> 11:38:22 and 11:39:34; all eleven returned `questions: []` and wrote a contract to
> `data/factory/lifemaxing/intake/`; no objective was created. `control-plane.json` has not been
> written since 2026-09-09 01:42:44, and `saveFounderJob` (`server.mjs:562`) runs before anything
> that can fail — so the objective POST never reached the server at all. The gap is client-side,
> after the intake response came back.
>
> Two things that are *not* the mechanism, ruled out: `setTimeout(route, 800)` re-renders the view
> but does not abort an awaited fetch chain, so a second click orphans nothing — only a page unload
> does; and no question modal was ever shown, because `natural-language-intake.mjs:63` returns
> `contractPath: null` when questions exist, and eleven contracts were written.
>
> Two adjacent defects fall out of the same trace. `preview` is destructured in
> `createContractFromObjective` (`natural-language-intake.mjs:17`) and **never referenced again**,
> so the preview intake behind `/api/founder/intake` writes a permanent contract exactly as a real
> start does — every abandoned click leaves an artifact nothing will consume. And `server.mjs` has
> **no request logging of any kind**, so "did the POST arrive" is answerable only by reading file
> mtimes; a `pm2 logs` tail stays silent whether the launch worked or failed.
>
> Objective drafted in `objective-console-launcher.md`. Work item 0 below.

## Weekly — two clicks

### 4. `Projects`
**Question: how is each project doing?**
Card per project: running / blocked / waiting-on-me, spend, deployment URL + last deploy state. Click filters the Board.
*Both surfaces.*

### 5. `Agents`
**Question: who is working, on what, since when?**
Every role: current task and stage, or idle/failed; harness **and the model seat it actually routes to**.
*Both surfaces.*

### 6. `Deliveries`
**Question: what has this factory produced, and what should I do next?**
Per finished deliverable: report, cost, PR, preview, suggested next step accepted in one click. **This replaces the empty Reports tab** and is fed by `/api/founder/tasks/:id/report`, which already works and nothing calls.
*Both surfaces.*

## Monthly — three clicks, local only

### 7. `Money` — budgets, cost limits, plan limits, scorecards
### 8. `Governance` — permissions, blast radius, retention, autonomy, approval keys
### 9. `Engine` — goals, proposals, learning, blind spots, system readiness, search

*These stay local. They are real and useful; they are not daily, and Today is currently drowning in them.*

## Everywhere
**`Task detail`** — the ported "Task execution" modal, reachable from any task anywhere. Both surfaces.

## Removed — with justification

| Removed | One-line justification |
|---|---|
| **SOPs tab** | Empty 3-byte file, no writer, no reader. Not "unused" — non-existent. |
| **Runs tab** | Reads `agent_runs` (1 row), a pre-factory table. The execution modal's timeline is the real thing and is better. |
| **Logs tab** | Same wrong database. Evidence paths + the execution modal replace it. |
| **Reports tab** | Empty collection. Replaced by `Deliveries` on the working route. |
| `/api/command-center/*`, `/api/overview`, `/api/outputs/cards` | Three superseded builders of the same screen, all fed by the near-empty legacy tables. |
| Workspace file editor routes | An arbitrary-file read/write editor on a founder surface; the evidence view covers the legitimate need. |

**Nothing real is dropped.** The Task Board is *kept* and made real — it is the one empty surface whose question genuinely matters.

## Coverage of everything you asked for

| You asked for | Local | Console | Status |
|---|---|---|---|
| All agents and what each is doing now | `Agents` | `Agents` | exists both; console needs the seat field (now published) |
| My projects | `Projects` | `Projects` | exists both |
| Tasks per project and each state | `Board` + `Projects` filter | same | **Board is empty today — the biggest repair** |
| What needs me | `Today` | `Today` | works both |
| Report per deliverable, cost, preview, one-click next step | `Deliveries` | `Deliveries` | route exists, **no UI**; preview link needs Phase 5; **one-click next step is genuinely new** |
| Task board showing where work sits | `Board` | `Board` | **empty today** |
| Where I hand the factory work, now or overnight | `Launch` | `Launch` | works locally; **console has none** |
| Global activity history | `Today → Activity` | `Today → Activity` | **exists locally (truncated, actor dropped); console renders nothing** |

**Holes I am naming rather than hiding:**

1. **"Suggested next step I can accept in one click" does not exist anywhere.** Nothing computes a next step for a finished deliverable. This is the only item on your list that is new construction, not repair.
2. **Preview links cannot exist until deployment records do** — no deployment record is written for any project and no project declares a URL.
3. **The console cannot yet start an objective**, because `objective.start` is allowlisted and unhandled.

---

# PART 4 — WORK LIST, ORDERED

Ordered by what unblocks the most. Tagged: **[FAKE→REAL]**, **[BROKEN→WORKS]**, **[MISSING]**, **[REORG]**.

| # | Work | Tag | Unblocks |
|---|---|---|---|
| 0 | **Launcher feedback while intake runs** — disable submit, show progress, question inline not modal; honour `preview`; log `/api/` requests | **BROKEN→WORKS** | handing the factory *any* work; it has already silently eaten one launch |
| 1 | **Board on real factory tasks**, both surfaces; delete the empty `tasks.json` path and its Edit button | **FAKE→REAL** | the single biggest lie on the surface; your most-requested view |
| 2 | **Activity on the console** — render `company.activityFeed`, already published | **MISSING** (render only) | Part 2's whole gap, at zero data cost |
| 3 | **Activity: show the agent, raise 10→30 locally and 30→200 in the snapshot** | **BROKEN→WORKS** | "which agent acted" — in the data, not on screen |
| 4 | **Deployment records + registry URL** (Phase 5 as proposed) | **MISSING** | every preview link, on every surface |
| 5 | **`Deliveries` screen** on the existing report route | **REORG** + MISSING | "what did we ship" — route works, nothing calls it |
| 6 | **Retire Runs / Logs / SOPs / Reports tabs** | **REORG** | four tabs of nothing; makes room for real ones |
| 7 | **Split Today** into Today / Money / Governance / Engine | **REORG** | Today currently carries ~14 panels |
| 8 | **Port the Task execution modal to the console** on the published per-task blobs | **MISSING** (render only) | 21 blobs already published, nothing renders them |
| 9 | **`Launch` on the console** — handle `objective.start` + `overnight.*` intents | **MISSING** | hand the factory work from your phone |
| 10 | **Console Projects + Agents** on the fields now published | **MISSING** (render only) | two of the four tabs |
| 11 | **Wire `POST /api/founder/projects`** to a UI | **MISSING** | registering a project without hand-editing JSON |
| 12 | **Surface `/api/system/readiness`** on Today | **BROKEN→WORKS** | would have shown the blob store suspended |
| 13 | **Delete the 3 superseded command-center routes + Agent Lab file routes** | **REORG** | dead weight, and one is an arbitrary-file editor |
| 14 | **Suggested next step per deliverable** | **MISSING** | genuinely new; the only item with no existing part |

## How much is repair vs construction

| Category | Items | Share |
|---|---|---|
| **Repair** — fake→real, broken→works | 0, 1, 2, 3, 4, 8, 10, 12 | **8 of 15 (53%)** — and these are the *largest* items |
| **Reorganise** | 5, 6, 7, 13 | 4 of 15 (27%) |
| **Genuinely new** | 9, 11, 14 | 3 of 15 (20%) |

Weighted by effort rather than count, it is closer to **60% repair / 25% reorganisation / 15% new**. Items 2, 8 and 10 are *render-only* — the data is already published and crossing the boundary; nothing needs to be built to carry it.

**Your suspicion is correct.** The pattern holds a fourth time: the Board exists and is empty, the activity view exists and the console cannot see it, the report route works and nothing calls it, the readiness check exists and would have caught the outage that cost eleven hours.

---

## What I could not determine

- **Whether `dashboard/backend/data/hq/*.json` was ever populated.** The files are 3 bytes dated 2026-09-04; `scripts/seed-hq.sh` would fill them from `examples/hq`, which I did not verify exists.
- **Whether the overnight queue has ever run.** Its SQLite store exists and its routes are real, but I did not exercise it.
- **Exact effort per item.** The ordering is by unblocking value, not by estimate.
