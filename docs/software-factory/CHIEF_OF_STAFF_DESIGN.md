# Chief of Staff — design

**Status: design only. Nothing in this document is built.**
Written 2026-09-15 against `main` @ `29e402c`. The console is being rebuilt this
week; building surfaces into it now guarantees a collision and a rewrite. This
document exists to be argued with.

---

## 0. The ask, and the gap

The founder's words: *"an ultimate project manager"*, *"a chief of staff capable
of delegating"* across several projects, so that he states an outcome and the
factory decides what to do and in what order.

What exists today:

| component | lines | what it does | what it decides |
|---|---:|---|---|
| `factory/lib/hq/chief-of-staff.mjs` | 109 | assembles company state, project status, agent activity, decisions, risks, learning findings into one contract | **nothing** — pure composition, read-only |
| `factory/lib/hq/proposer.mjs` | ~300 | ranks blocked work, neglected goals and recurring findings; caps at 3 | **nothing** — explicitly report-only, "never invents" |
| `factory/lib/hq/goals.mjs` | ~200 | projects a company→project→objective goal tree over canonical work | **nothing** — no runtime write path; goals are a tracked file |

The name is taken but the job is not done. `chief-of-staff.mjs` is a *briefing
pack*. `proposer.mjs` is an *opinion*. **Between them there is no component that
decides, and no component that acts.** The founder still types every objective.

The gap is not intelligence. It is **authority**: nothing in this codebase is
allowed to start work.

---

## 1. What decision does it own that nothing owns today?

**It owns sequencing and admission: which already-approved work starts next, and
when.** That is the decision that currently has no owner. Today an objective
starts because the founder typed it, and the overnight queue runs what is in it
because it is in it.

The boundary, stated as three lists. These are the whole contract; anything not
in list A is not its decision.

### A. Decides alone, acts without asking

1. **Ordering the admitted set.** Given work the founder has already approved,
   choose what runs next and in what order.
2. **Admission against a concurrency and budget envelope.** Hold work back when
   starting it would exceed the envelope (§3). Holding is always safe; it is the
   *only* safe unilateral action, because it is reversible by doing nothing.
3. **Deferring a re-wake.** Already precedented: `rewake-throttle.mjs` defers a
   fruitless re-wake today without spending a retry.
4. **Declaring an objective stalled and stopping it.** With a stated reason, on a
   measured threshold (§5 shows why this one matters).
5. **Reporting.** Not optional, not a side effect — a decision it does not report
   is a defect (§4).

### B. Proposes, founder disposes

6. **New objectives.** It may draft one, from a goal in `factory/goals.json` with
   no work under it. It may not start one. `proposer.mjs`'s rule — *a proposal
   must point at something already in canonical state* — extends to drafts: a
   draft names the goal it came from, or it is not written.
7. **Re-scoping or splitting an objective** that is failing for structural
   reasons.
8. **Raising the budget envelope.** It may spend up to the envelope and must ask
   to widen it.

### C. Must never decide

9. **Anything already founder-gated stays founder-gated.** High-risk approval,
   Decision Cards, merges to `main`. The evidence that this line is real is
   `escalation-gate.mjs`, which was added precisely because agents were paging
   the founder about reversible UI scope calls — the factory's problem has been
   *mis-calibrated* escalation, not too much of it.
10. **Its own budget envelope, concurrency ceiling, or the gate model policy.**
    A component that can widen its own limits has no limits.
11. **Never cheapens a gate.** `factory.config.json` sets review selection to
    `different-model-from-builder` for **independence, not cost**. The cost
    measurement (`docs/cost-measurement-2026-09-15.md`) found gates are 49.3% of
    spend, which makes them exactly the tempting target. Off limits.
12. **Never edits acceptance criteria.** It may report that criteria are
    unfalsifiable (§5) and stop the work. Rewriting the bar you are judged
    against is the one edit no autonomous component may make.

**The one-sentence version:** it decides *when* approved work runs, never *what*
work is approved, and never what "done" means.

---

## 2. Where does the goal tier live?

**It sits on the goal tier. It does not replace it, and it must not.**

`goals.mjs` already is the tier above objective, and its central design choice is
the reason to build on it rather than beside it:

> *"a goal here carries founder INTENT and nothing else. Every status and
> percentage in a projection is derived from canonical objective/task state, so
> no agent can report a goal complete without delivery evidence, and a goal can
> never become a second, competing workflow state."*

That property — **intent is declared, status is always derived** — is exactly what
makes a deciding component safe to add. The chief of staff reads
`projectGoals()`, and cannot mark anything complete, because there is nothing to
mark. Progress is a function of canonical work or it does not exist.

Two consequences I am taking deliberately:

- **Goals stay a tracked file** (`factory/goals.json`, changed by PR). The chief
  of staff gets no write path to intent. It proposes goal-level work; changing
  what the company wants stays a reviewed commit. This is slower than a runtime
  goal API and that is the point.
- **I am not adding a tier.** `claude/missing-layers-design.md` argues for a
  missing tier above objective. **I could not find that file** — it is not in
  this repo or anywhere on this machine, and the founder should hand it over
  before this section is treated as settled. Reading only `goals.mjs`, the tier
  it describes appears to already exist in projection form; what is missing is
  not a tier but an *actor* on it. If the design doc argues something else, this
  section is the one to revisit.

**Rejected alternative:** giving the chief of staff its own goal store with
editable status. It would let it report progress directly — and it would
reintroduce exactly the second competing workflow state `goals.mjs` was written
to prevent. Rejected on those grounds alone.

---

## 3. What is its budget authority?

### The finding that settles this

`factory/budgets.json` sets a company limit of **$200/month**, alert-only.

Measured factory agent spend, 2026-09-09 → 09-14: **$98.16 over five days** =
$19.63/day ≈ **$589/month**. That is **2.9x over the founder's own stated
limit**, and no alert has ever fired — because the cost ledger reports
**$0.0851** for that window, or **0.04% of the limit**. (The ledger records one
message where a session happened; see `docs/cost-measurement-2026-09-15.md`.)

**So: the budget system has never once been tested against a real number.**

### What changes

The order is not negotiable, and it is a hard prerequisite chain:

1. **Fix the capture defect first.** Until the ledger measures real spend, every
   budget number is theatre. **No autonomous spending authority before this
   lands.** A component that decides how much to spend against an instrument
   reading 0.04% of reality is worse than no component.
2. **Then give the chief of staff an envelope, not a budget.** A dollar ceiling
   per window that it may spend down and may never raise (list C). Distinct from
   `budgets.json`, which stays the founder's alert-only *visibility* tool — one
   of these is a speedometer, the other is a governor, and merging them loses
   both.
3. **Enforcement is `hold`, never `kill`.** Crossing the envelope stops
   *admission* of new work. It never cancels a running dispatch, never rolls back,
   never interrupts a gate mid-flight. Holding is reversible; killing is not, and
   the factory has already demonstrated (§5) that it will do the wrong thing
   confidently at 3am.
4. **The envelope is denominated in money and time.** A concurrency cap alone
   does not bound spend when one reviewer session can read 162k tokens.

### The number I would start with

$50/week, hold-on-exceed. Roughly a third of measured run-rate — deliberately
tight, because the failure mode of too tight is *the founder gets asked*, and
the failure mode of too loose is *a student's money is gone*. It should be raised
from evidence after the first month, not guessed upward now.

---

## 4. How does it avoid the failure this project already had?

**The failure:** for five days LifeMax shipped and the founder did not know. A
component that decides and does not report is that same failure with more
autonomy — which makes reporting a *correctness property of this design*, not a
feature of it.

Four rules, in decreasing order of how much I trust them:

1. **Every decision writes a record, in the same transaction as the decision.**
   Not a log line after the fact. `mutateTransactionalState` already makes
   decision-and-record atomic; a decision whose record failed to write did not
   happen. This is the only one of the four that cannot rot.
2. **Silence is a reportable state.** The specific LifeMax failure was not a
   missing alert, it was *nothing being wrong enough to alert*. So the chief of
   staff emits a heartbeat on a fixed cadence whether or not anything happened,
   and **a missing heartbeat is itself the alarm.** "No news" must be
   distinguishable from "not running" — that distinction is the entire lesson of
   those five days.
3. **It reports what it *chose not to* do.** Held work, deferred re-wakes,
   proposals it declined to raise. The decisions that leave no trace in canonical
   state are exactly the ones that make an autonomous component unauditable.
4. **It never reports a number it cannot source.** Standing rule on this project.
   Given §3, it must label spend as a floor until the capture defect is fixed —
   a chief of staff quoting the current ledger would be the third time this
   project has handed the founder a wrong cost number.

**Rejected:** routing reports through the Founder Inbox. That surface is gated by
`escalation-gate.mjs` for good reason, and a heartbeat is not an escalation.
Mixing them either floods the inbox or teaches the founder to ignore it.

---

## 5. What would it have done differently on two real cases?

### Case 1 — `obj-c58897c0-integration`, the circular criteria

**What happened:** 17 attempts, 6 review rejections. Acceptance criterion 2 was
*"The combined change passes independent review, QA, and security"* — circular,
defining passing the gate as passing the gate. No falsifiable condition, so an
uneasy reviewer had no bar to measure against and no way to clear it. The node's
contract also embedded the entire 1,307-line objective (24 KB) as its `outcome`,
handing a merge-and-verify job the full "INVENT THE PRODUCT" brief.

**What the chief of staff would have done: stopped it at attempt 3, and said
why.** Concretely:

- The signal is available and needs no judgment: **rejections rising while the
  node's diff is not converging.** That is countable from canonical state today.
- Authority to act exists (list A item 4: declare stalled, stop, state reason).
- **It would not have fixed the criteria** (list C item 12). It would have
  reported: *"integration has failed review 3 times; criterion 2 contains no
  falsifiable condition; this needs a founder decision."*

**Value: real, and it is the 14 avoided attempts** — each one a full-context
agent call, on the most expensive stage class in the measurement. This is the
case where the design clearly pays.

**Honest limit:** it detects the *shape* (repeated failure, no convergence), not
the *cause* (the criterion is circular). A human reading criterion 2 sees the
problem in seconds; this design sees "stuck" and escalates. That is a real
improvement over 17 attempts and materially less than understanding.

### Case 2 — the 403 GiB write storm

**What happened:** `toResponse` defaulted to returning the whole state document,
so every mutation wrote a full copy of the task's state into the idempotency
ledger. 195 KiB × ~2.21M mutations = 403 GiB, for a task with 15 dispatches.
Caught when the disk hit 97%.

**What the chief of staff would have done: essentially nothing, and this is a
finding, not a failure.**

- It reasons over *canonical work state* — objectives, tasks, goals, spend. The
  storm was invisible there: the task looked like a task with 15 dispatches. Its
  whole input contract was clean while the disk filled.
- The one place it might have caught an edge: **mutation rate is a countable
  property of the work it admits**, and 2.21M mutations against 15 dispatches is
  five orders of magnitude out. A cheap invariant — *mutations per dispatch* —
  would have fired. But that is a **health check, not a decision**, and I would
  rather name it as such than credit it to this design.

**Conclusion: the chief of staff is the wrong layer for this class of failure.**
Infrastructure pathology needs resource monitoring, which is a separate,
simpler, and more reliable thing than a reasoning component. **Do not let a
chief of staff project absorb it** — that would produce a component that is
mediocre at two jobs, and the slower job would mask the faster one.

That is one clear win and one clear miss. A design that claimed both would be
overselling.

---

## 6. The smallest first version worth shipping

**v0: the admission controller.** It does exactly one thing from list A:

> Given the objectives the founder has already approved and the overnight queue,
> decide **what starts next and what is held**, against a concurrency cap and a
> weekly dollar envelope — and write a record of every choice, including the
> holds.

**Why this is the right first slice:** it is the smallest change that makes the
component *decide* rather than *report* — crossing the gap in §0 — while every
decision it makes is reversible by doing nothing. It needs no new goal tier, no
console, and no new authority over gates.

**Explicitly not in v0:** drafting objectives (§1B), stall detection (§5 case 1 —
it needs a convergence measure that does not exist yet), anything touching
gates, anything touching `goals.json`.

### Hard prerequisites, in order

1. **The cost capture defect is fixed.** Non-negotiable per §3. Today's ledger
   under-reports by ~1,150x; an envelope enforced against it is enforced against
   nothing.
2. **`factory/budgets.json` gains an envelope** distinct from its alert policies.
3. **A decision record exists in canonical state**, written in the same
   transaction as the decision (§4 rule 1).

### What it needs from the console, once that settles

Deliberately small — three read-only additions, no new interactive surface:

- **A held-work row.** What is waiting, why, and what would release it. This is
  the one thing that must exist, or holds are invisible and the component is
  unauditable.
- **The envelope as a meter**, showing spend against it and labelled with its
  confidence — a floor until prerequisite 1 lands.
- **The heartbeat, with its absence visible** (§4 rule 2). A stale heartbeat has
  to *look* wrong at a glance; that is the LifeMax lesson rendered as UI.

No approve/reject buttons in v0. It has no authority a founder needs to approve
in-flight — and if it ever does, that is a Decision Card, not a button.

---

## Trade-offs this design rejects

- **A chief of staff that writes goal status.** Rejected: reintroduces the second
  competing workflow state `goals.mjs` exists to prevent (§2).
- **Cancel/kill authority.** Rejected: hold is reversible, kill is not, and
  unattended irreversible actions are how this project got a 403 GiB file (§3).
- **Letting it tune gate routing for cost.** Rejected: the gates are where the
  money is, which is exactly why this is the tempting and wrong lever (§1 C11).
- **Shipping it before cost capture is fixed.** Rejected: a spending authority
  reading 0.04% of reality (§3).
- **Folding infrastructure health into it.** Rejected: §5 case 2 — wrong layer,
  and it would mask the faster signal behind the slower one.
- **Building it into the console this week.** Rejected: the console is being
  rebuilt; a design the founder can argue with is this week's useful artifact.

---

## Open questions for the founder

1. **`claude/missing-layers-design.md` is not on this machine.** §2 is reasoned
   from `goals.mjs` alone. If that document argues for a genuinely new tier, §2
   is the section to revisit.
2. **Is $50/week the right envelope?** §3 proposes it as deliberately tight. Real
   run-rate is ~$137/week against a $200/month stated budget — so the budget
   itself may be the number that needs revisiting, not the envelope.
3. **Should v0 hold work at all, or only report what it *would* hold?** A
   report-only v0 is one step smaller and proves the ranking is trustworthy
   before it is load-bearing. It also means another week of the founder typing
   every objective. I lean to holding, with a founder-settable kill switch, but
   this is a genuine judgment call and it is the founder's.
