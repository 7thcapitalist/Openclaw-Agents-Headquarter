# Decision Required

## Decision
Who may read the hosted Headquarters view, and how is that enforced?

## Why this needs the founder
DC-2026-003 settled the network boundary, the data scope, the write credential,
retention and rollback. It did not settle **who may read the result**.

The signed data scope is wide by design — "everything the dashboard shows":
goal titles and progress, objective and task state, interaction threads, run
timelines, evidence paths, founder inbox contents, cost totals, plan limits,
agent names and scorecards. That scope was reasonable against a control plane
the founder reaches. A `*.vercel.app` URL is world-readable by default, and the
address is guessable from the repository name — which is exactly the address the
current deployment is on.

The local dashboard has never been open: it is password-protected and
session-bound, and `:3211` refuses an unauthenticated request today. Publishing
the same projection without an equivalent gate would silently widen access far
past anything DC-2026-003 asked for. That is a privacy posture change, which the
operating rules put on the founder rather than on an agent.

This card gates campaign node #187. Node #186 — the empty shell that fixes the
404 — carries no company data and proceeds regardless.

## Option A — application password and session, mirroring the local dashboard
The control plane holds one shared secret and issues a session cookie, the same
model `dashboard/backend/server.mjs` already uses.

- **Benefit:** no recurring spend, no new vendor dependency, no new account to
  administer. The model is already understood and already operated here. Works
  identically on every plan and survives moving off Vercel entirely.
- **Cost/risk:** a shared secret is only as good as where it is kept, gives no
  per-viewer audit trail, and rotating it logs everyone out. One password is
  fine for one founder and does not grow into a team.

## Option B — Vercel Deployment Protection
Let the platform gate the deployment, so only the Vercel account may view it.

- **Benefit:** no auth code in the application at all, and therefore no auth bug
  in the application. Enforced before the request reaches any function.
- **Cost/risk:** protecting a **production** deployment is a paid-plan feature —
  on the current Hobby account this likely means a Pro subscription, which is
  recurring spend and needs its own approval. It also binds reachability to the
  Vercel login, which is the single thing this design was meant to stop
  depending on a specific machine or session for.

## Option C — GitHub OAuth, allowlisted to one account
Sign in with GitHub; authorize exactly `7thcapitalist`.

- **Benefit:** no shared secret, a real per-viewer identity and audit trail, and
  a clean path to adding a second person later without redesigning anything.
  The GitHub account is already the durable record's owner (SFD-2026-001).
- **Cost/risk:** the most code of the three, one more credential pair to hold,
  and it makes reading HQ depend on GitHub being up.

## Recommendation
**A**, with **C** as the stated upgrade path. A matches the model already
operated on this machine, adds no spend and no vendor coupling, and is
sufficient for a single-founder control plane. C becomes the right answer the
moment a second person needs to read HQ, and node 2 should keep its auth check
in one place so that swap is a contained change rather than a rewrite.

B is not recommended: it converts a reachability decision into a subscription
and reintroduces a dependency on one provider's login.

Whichever is chosen, node 2 must keep the check at a single boundary so the
answer can be changed without touching the store or the renderer.

## Default if no decision
Node #186 lands — the URL serves an honest empty state and stops returning 404.
Nodes #187-#191 stay prepared but unmerged. No company data is published, no
write credential is created, and the Cloudflare tunnel keeps running as the
founder's remote access.

## Reply format
`A`, `B`, `C`, or `Other: ...`.
