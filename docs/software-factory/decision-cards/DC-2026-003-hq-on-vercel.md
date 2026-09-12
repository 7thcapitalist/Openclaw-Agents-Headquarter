# Decision Required

> **Resolved 2026-09-12 — Option A accepted by the founder**, with data scope set
> to the full dashboard projection. Recorded here before any connector code was
> written, as `factory/lib/integrations/connector-outbox.mjs` requires.

## Decision
Should Headquarters be reachable through a public Vercel deployment that the
mini-PC talks to **outbound only**, retiring the Cloudflare tunnel — or should
HQ stay reachable only through a tunnel into the machine?

## Why this needs the founder
`connector-outbox.mjs` was deliberately built with no network capability and
states that a live connector requires a founder decision covering host, network
exposure, credentials, data scope, retention, resource limits, backup and
rollback. This is that decision. It also moves company data off the founder's
machine for the first time, which is not a call an agent should make.

**HQ cannot simply be hosted on Vercel.** The dashboard spawns the `openclaw`
and `pm2` binaries, drives git worktrees on disk, and reads a 27 MB local SQLite
database. Vercel functions are serverless: no persistent disk, no daemons, no
local binaries. The factory needs a machine either way. What is actually being
decided is where the *control plane* lives, not where the factory runs.

## Option A — Vercel control plane, outbound-only mini-PC
Vercel hosts the UI and a durable store holding two things: the published state
projection, and a queue of founder intents. The mini-PC **polls**: it pulls
pending intents and executes them, and pushes state snapshots back. It never
listens on a public port.

- **Benefit:** the tunnel is deleted outright. The machine has **no public
  ingress at all**, which is a stronger position than a tunnel, not a weaker
  one — a tunnel is an open inbound path to a home network. HQ becomes reachable
  from anywhere with a stable URL that does not change on restart.
- **Cost/risk:** company data leaves the machine and lives on Vercel. Founder
  actions become eventually-consistent — an approval takes up to one poll
  interval rather than being instant. A new credential to hold and rotate. More
  moving parts to keep healthy.

## Option B — keep a tunnel into the machine
Replace the quick tunnel with a stable named Cloudflare tunnel.

- **Benefit:** no company data leaves the machine. Roughly fifteen minutes of
  work. Actions stay instant.
- **Cost/risk:** preserves a public inbound path into the home network, which is
  the larger standing exposure. Does not address reachability if the machine's
  network changes, and keeps HQ's availability tied to one residential link.

## Recommendation
**A.** The security argument runs the opposite way to intuition: retiring the
tunnel *removes* the only public inbound path to the machine. Everything after
that is outbound. The latency cost is real but small against an approval that
already waits on a human.

---

## Founder decisions recorded

### Network boundary
Outbound only. The mini-PC opens connections to Vercel and never accepts them.
No port forwarding, no tunnel, no inbound listener reachable from the internet.
The local dashboard on `:3211` stays bound to localhost for on-machine use.

### Data scope — **everything the dashboard shows**
Published: the full projection the local dashboard renders today — goal titles
and progress, objective and task titles and state, task detail, interaction
threads, run timelines, evidence *paths*, founder inbox contents, cost totals,
plan limits, agent names and scorecards.

Never published, and enforced by test rather than by care:
- repository source, file contents and diffs
- secrets, credentials, API keys, tokens, private keys
- `.env` contents and anything matching the existing secret patterns
- evidence file *bodies* — paths only
- absolute filesystem paths from the host

### Credentials
One write credential, held by the mini-PC, scoped to publishing state and
claiming intents. Never present in the repository, never in an artifact, never
in a log. Rotatable without redeploying the factory.

### Retention
The published projection is a mirror, not a record of origin. The canonical
record stays on the machine and in GitHub. Anything published is disposable and
may be deleted wholesale at any time without data loss.

### Rollback
Three levels, each independently sufficient:
1. stop the publisher — the hosted view goes stale and says so
2. delete the Vercel project — HQ is reachable on `:3211` locally, unchanged
3. `git revert` the feature commits — the factory never depended on any of it

The local dashboard keeps working throughout. Nothing in this design makes the
factory require the network to run.

## Default if no decision
Work that does not cross the boundary continues: the deployments panel (#180),
and the projection builder with its redaction tests — which is useful on its own
as a portable snapshot. No connector, no credential and no publishing is built
until this card is signed.

## Reply format
`A`, `B`, or `Other: ...`.
