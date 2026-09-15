# Decision Required — DC-2026-006

**Raised:** 2026-09-15 · **Raised by:** Claude (architecture) · **Status:** open

## Decision

Should the factory trust **more than one founder approval key at a time**, so that high-risk builds can be approved from the hosted console as well as from the tunnel?

## Context — why this is not just "wire the buttons"

`approval.submit` and `approval.reject` are already in the intent allowlist, with an
8000-character `assertion` argument sized for an Ed25519 signature. Wiring their
handlers is an afternoon. The reason it has not been done is the key, and the
problem is **not** the one it first appears to be.

There is no key-custody problem. `dashboard/backend/public/lib/founderApproval.mjs`
generates a **non-extractable** Ed25519 key inside the browser and stores it in
IndexedDB. The private key cannot be read by that code, by the server, or by any
factory agent — only the public key and signatures ever leave the browser. Putting
approvals on the hosted console would not move a private key anywhere.

The problem is that **the key is bound to the browser origin**, and the factory
trusts exactly one at a time:

- IndexedDB is partitioned per origin, so the key enrolled at the tunnel origin
  does not exist at the Vercel origin. The console would generate its own.
- `enrollFounderKey` (`dashboard/backend/lib/founderApproval.mjs:116`) treats a
  second, different key as a **rotation**, and a rotation must be signed by the
  current key.
- Tasks already carry the fingerprint they were created under. After a rotation,
  `submitFounderApproval` refuses them with `KEY_MISMATCH` — *"This task was
  created under a different approval key. Re-key it to your current key, then
  approve."*
- `factory/lib/founder-authority.mjs` resolves **one** trusted authority from an
  anchor, and that anchor overrides whatever a task's own state claims.

So enrolling the console's key would not add a second way to approve. It would
**replace** the tunnel's key, and every pending high-risk task would need
re-keying before it could be approved from anywhere.

## Option A — one key, and the console does not approve

Keep a single enrolled key. The console shows a pending approval, explains that it
must be signed from the tunnel, and links to it. `approval.submit` and
`approval.reject` stay unwired.

- **Benefit:** no change to the authority model, which is the strongest security
  property this factory has. One key, one holder, one fingerprint on every
  approved task, and an audit trail with nothing to reconcile.
- **Cost/risk:** high-risk work cannot be approved from a phone. If the founder is
  away from the tunnel, a blocked high-risk objective stays blocked. This is the
  status quo, and it is the thing that prompted the question.

## Option B — a trusted key set, one key per device

Let the factory trust a **set** of founder public keys, each enrolled once and
individually revocable. Approval succeeds if the assertion verifies against any
member. Every approved task records which key signed it.

- **Benefit:** approval works from the console, the tunnel, and any future device,
  with no rotation and no re-keying. Losing a laptop revokes one key instead of
  invalidating every pending task. The signature is still non-extractable and still
  made in the browser.
- **Cost/risk:** the authority model becomes a set rather than a scalar, and
  `founder-authority.mjs`, `enrollFounderKey`, the `KEY_MISMATCH` path, the anchor
  resolution and the rotation-history test all have to learn that. It widens the
  approval surface from one browser to N, so enrollment itself becomes the thing
  that must be protected — a key enrolled by someone else is a founder. Enrolling a
  new key would need to be signed by an existing one, which means the FIRST
  enrollment on a new device still has to happen somewhere already trusted.

## Other

The founder may describe another option in one sentence — for example, approving
from the console by relaying an assertion produced on the tunnel, or accepting a
second key only for a bounded risk class.

## Recommendation

**A for now, B when high-risk work actually blocks you.**

The console campaign (#258–#262) delivered starting work, planning the night,
accepting proposals and asking questions, and none of those touch the authority
model. Approval is the one control where the current design is doing real work,
and the cost of getting a key set wrong is that someone else can authorise a
high-risk build.

Option A is not free — it leaves a real gap — but it is honest about where the
gap is, and B is a security change that deserves its own design rather than being
carried along by a UI campaign. If high-risk objectives start waiting on you
while you are away from the tunnel, that is the signal to do B properly.

## Default if no decision

Everything in the console campaign ships and works. `approval.submit` and
`approval.reject` stay allowlisted-but-unwired, and an intent naming them is
rejected with a displayable reason rather than failing silently — the behaviour
asserted by `factory/test/intents-console-actions.test.mjs`.

The console will continue to show high-risk approvals as things that need the
founder, without offering a button that cannot complete.

## Reply format

`A`, `B`, or `Other: ...`.
