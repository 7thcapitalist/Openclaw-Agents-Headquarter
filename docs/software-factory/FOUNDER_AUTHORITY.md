# Founder Authority and Headquarters Security (FCT-P0-04)

Status: implemented — SFD-2026-010 Batch 3.

This document states what actually authorizes a high-risk operation, what does
not, and which browser-facing attacks Headquarters now defends against.

## 1. The rule

> A high-risk task moves past `builder` if, and only if, an Ed25519 assertion —
> scoped to that task, that challenge, that action, and that evidence — verifies
> against the approval authority recorded on the task.

No strategic decision, task-contract field, or dashboard action is an
alternative to that signature.

The key that signature is checked against comes from **outside** the task
state — the enrolled key file or `FACTORY_FOUNDER_PUBLIC_KEY` — so an actor
who can write task state cannot substitute its own. See §3.1.

## 2. The vulnerability this closes

`factory/lib/task-workflow.mjs` previously contained:

```js
function hasValidFounderApproval(state) {
  if (hasFounderDecision(state)) return true;   // ← the bug
  ...
}
```

`hasFounderDecision()` returned true when `state.founderDecisions` held any
entry with a non-empty `direction` string.

`founderDecisions` entries are written by
`dashboard/backend/lib/founderControlPlane.mjs` from a plain text field in the
dashboard. They are strategic answers — "use the hosted option", "prefer
Postgres" — carrying no signature and no proof of authorship.

The consequences were:

1. **Answering an ordinary product question silently authorized the build.** A
   task that asked the founder to choose a direction, got an answer, and later
   reached the high-risk gate walked straight through it. The founder was never
   shown the high-risk decision at all.
2. **The gate was reachable by anything that could write task state.** An agent,
   a recovery path, or a compromised dashboard session could append one
   `founderDecisions` entry and clear the gate without possessing any key.
3. **`isAwaitingFounderApproval()` returned false**, so the Founder Inbox did not
   even list the task as waiting. The bypass was invisible.

Regression coverage: `factory/test/task-workflow.test.mjs` —
"a strategic founder decision does NOT authorize a high-risk build" and "no
number of founder decisions adds up to an approval".

Strategic decisions are still recorded, still rendered in handoffs, and still
included in completion reports. They are evidence. They are not authority.

## 3. What an approval binds to

The signed payload (`founderApprovalPayload`) covers:

| Field | Why |
| --- | --- |
| `taskId` | An approval for one task cannot be used on another |
| `challenge` | Per-task random UUID; defeats replay onto a later gate |
| `decision` | The exact requested action, e.g. `approve-high-risk-build` |
| `evidenceSha256` | Digest of what the founder actually read |
| `approvedAt` | Anchors expiry; a stale approval is not a standing grant |
| `authorityFingerprint` | **v2** — binds the approval to the signing key |
| `version` | Prevents silent downgrade to the weaker v1 shape |

Verification additionally enforces:

- **Expiry** — `FACTORY_APPROVAL_TTL_SECONDS` (default 24h) bounds how long a
  signature may sit **unused before it is recorded**. It is deliberately *not*
  re-evaluated afterwards. Re-checking age at every later gate killed tasks the
  founder genuinely approved whose pipeline outran the TTL, and left them
  unrecoverable: once an approval is recorded `isAwaitingFounderApproval()` is
  false, so the Inbox will not offer re-approval and `prepareFounderApproval`
  refuses. Revocation, not expiry, withdraws a recorded approval.
- **Clock skew** — an approval dated more than 2 minutes in the future is refused.
- **Revocation** — a fingerprint in `state.founderApprovalRevocations` stops
  verifying immediately, even for an approval that was previously valid.
- **Fail-closed signatures** — a malformed or wrong-length signature returns
  false rather than throwing something a caller might treat as infrastructure.

### 3.1 Where the trusted key comes from

A signature check is only as good as the key it trusts, so the key is resolved
from **outside** the task state. Resolution order — first hit wins, and it
**overrides whatever the task state claims**:

1. an authority injected by the caller;
2. a root set once at startup via `configureTrustedAuthority({ hqRoot })`;
3. `AGENT_LAB_ROOT`;
4. the repository root derived from this module's own location;
5. `FACTORY_FOUNDER_PUBLIC_KEY`.

Steps 3 and 4 exist because threading an `hqRoot` option through every gate
**did not work**. A second independent review proved that exactly one production
call site passed it, so the builder gate, the release gate, every resume path and
all six CLI scripts silently fell back to the task's own key — the original
vulnerability, intact, with the security posture depending on which process
happened to run the stage. Resolution has to work by default, so it does.

**Fail closed.** If no anchor resolves, a high-risk approval is **refused**, not
downgraded. Previously an unreadable anchor fell back to the task's own record,
so deleting one small file was a complete and silent bypass. The escape hatch
`FACTORY_ALLOW_UNANCHORED_APPROVAL=1` is opt-in and deliberately awkward.

**Symlinks are refused.** `lstat` is checked before reading: an actor able to
write the data directory could otherwise point the anchor at a key it controls
while the result still reported `source: "enrolled"` — tampering invisible in
the field meant to reveal it.

If the task's recorded `founderApprovalAuthority` disagrees with the anchor, the
approval is refused as tampering. Only Ed25519 may anchor the gate; a malformed
or wrong-type anchor is ignored (and therefore fails closed).

## 4. Assertion versions and migration

| | v1 | v2 (current) |
| --- | --- | --- |
| Binds task/challenge/action/evidence/time | yes | yes |
| Binds the approval-authority fingerprint | **no** | yes |
| Issued to new tasks | no | yes |

**Existing pending approvals keep working.** Verification reads the version from
the task's own `founderApprovalRequest`, so a task created before this change
continues to verify as v1. A v1 assertion presented against a v2 request is
rejected as a downgrade (`/version mismatch/`).

Migration options for a pending v1 task:

1. **Do nothing.** It remains approvable as v1 until it completes.
2. **Re-key it** — `POST /api/founder/approvals/:taskId/rekey`. For a v2 request
   this also issues a **fresh challenge**, so any signature made under the old
   key becomes permanently unusable rather than merely mismatched.

There is no automatic upgrade of a v1 request to v2: silently restamping a
weaker record as a stronger one is exactly the kind of move this work exists to
prevent.

### Rollback

Revert the PR. v2 requests on in-flight tasks then fail closed (`version
mismatch`) rather than falling back to a weaker check — those tasks must be
re-keyed, which re-issues a v1 request. No approval is ever silently downgraded.

## 5. Threat model

| # | Threat | Defense | Test |
| --- | --- | --- | --- |
| T1 | Ordinary decision used as authorization | `founderDecisions` removed from the gate | `task-workflow.test.mjs` |
| T2 | Approval replayed onto another task | `challenge` + `taskId` in signed bytes | `founder-authority-gate.test.mjs` |
| T3 | Evidence swapped after signing | `evidenceSha256` re-checked at execution | same |
| T4 | Different action substituted | `decision` in signed bytes | same |
| T5 | Old/compromised key reused | authority fingerprint binding + revocation | `founder-authority-gate.test.mjs` |
| T5b | Authority key swapped by an actor who can write task state | external trust anchor overrides the recorded key | `founder-authority-anchor.test.mjs` |
| T6 | Malformed signature treated as an error, not a denial | fail-closed verify | same |
| T7 | Stale approval used much later | TTL + future-date rejection | same |
| T8 | Downgrade to v1 | version equality check | same |
| T9 | Agent-authored HTML executing as the founder | sanitizer + CSP | `dashboard-markdown-xss.test.mjs` |
| T10 | Cross-site forged mutation | Origin check + session-bound CSRF token | `dashboard-http-security.test.mjs` |
| T11 | Password guessing | per-client backoff + global ceiling | same |
| T12 | Session fixation | session id rotated on login | same |
| T13 | Privileged action with no attribution | append-only audit log | `dashboard-security-audit.test.mjs` |

### Residual risk (stated, not solved here)

- **The anchor file shares the agents' uid.** The threat model is "an actor who
  can write task state", and factory agents are not filesystem-sandboxed: they
  run as the uid that owns `dashboard/backend/data/factory/founder-approval-key.pem`.
  Such an actor can overwrite the anchor itself. Symlink redirection is refused
  and the mismatch check still fires, but co-located ownership means the anchor
  raises the bar rather than being an absolute boundary. Storing it under a
  different uid, or outside the repo tree, is the real fix.

- **Trust-on-first-use enrollment.** The first browser key is still accepted on
  the strength of an authenticated session alone. Rotation afterwards requires a
  signature from the current key. Whoever holds the first authenticated session
  before any key exists can enroll one. Enrollment is logged loudly and audited.
- **One shared dashboard password.** Login is a single secret with no second
  factor. Throttling raises the cost of guessing; it does not replace MFA.
- **`style-src 'unsafe-inline'`.** The dashboard builds first-party inline style
  attributes. Inline CSS cannot execute JavaScript, and the sanitizer strips
  `style` from all untrusted content, so agent CSS never reaches the page.
- **In-memory throttle counters.** A process restart clears them. An
  unauthenticated attacker cannot cause a restart.

## 6. Browser hardening

### Markdown sanitization

`dashboard/backend/lib/safeMarkdown.mjs` is the only path from untrusted
Markdown to HTML. Two independent layers:

1. **Generation** — a `marked` renderer that never emits author-supplied HTML.
   Raw HTML becomes escaped text; every URL is scheme-checked before it reaches
   an attribute.
2. **Serialization** — the generated HTML is re-parsed against a strict
   tag/attribute allowlist. Every `on*` handler, `style`, and unknown attribute
   is dropped.

URL checking decodes HTML entities *before* testing the scheme, because the
browser does too — otherwise `&#106;avascript:` slips past.

Dashboard UI class names are also refused on untrusted content, so an agent
cannot forge interface chrome such as a fake approve button.

All four `marked.parse()` sinks in `server.mjs` now route through this module.

### Content Security Policy

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; connect-src 'self'; object-src 'none';
frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'
```

`script-src 'self'` is the load-bearing directive: injected markup cannot
execute even if something reaches the DOM. The dashboard has no inline
`<script>`, so this costs nothing.

### CSRF

Every mutating request needs **both**:

1. An `Origin`/`Referer` belonging to this deployment.
2. `X-CSRF-Token` matching the token bound to the session (constant-time compare).

`/api/auth/login` is exempt — no session-bound token exists yet — and is
protected by throttling and the password instead. `SameSite=lax` is a third
layer, not relied upon.

Extra origins: `DASHBOARD_ALLOWED_ORIGINS` (comma-separated).

### Login throttling

Per-client exponential backoff after `DASHBOARD_LOGIN_MAX_ATTEMPTS` (default 5)
within `DASHBOARD_LOGIN_WINDOW_MS` (default 15m), plus a global ceiling so an
attacker spread across many addresses still hits a limit. A throttled response
is `429` with `Retry-After`, and refuses the **correct** password too — a
throttle that lets the right guess through slows nothing down.

### Session fixation

`POST /api/auth/login` rotates the session id via `regenerateSession()` before
marking it authenticated, carrying session contents across and issuing a fresh
CSRF token.

## 7. Audit trail

`dashboard/backend/data/factory/security-audit.jsonl`, append-only, mode `0600`.

Recorded: `login.succeeded`, `login.failed`, `login.throttled`, `logout`,
`approval-key.enrolled`, `approval-key.rotated`, `approval.granted`,
`approval.declined`, `approval.rejected-by-gate`, `approval.rekeyed`,
`task.retried`, `process.start|stop|restart`, `config.updated`.

Each record carries a timestamp, actor, outcome, a hashed session handle, IP, and
user agent.

**Never recorded:** signatures, assertions, private keys, passwords, session
secrets, or CSRF tokens. Sensitive fields are replaced with
`[redacted:<12-hex digest>]` — enough to correlate two events, useless as a
credential. Redaction is recursive, depth-limited, and size-bounded.

A write failure degrades to stderr rather than failing the request: losing the
founder's action would be worse than the gap. A corrupt line is surfaced as
`{ corrupt: true }` rather than silently skipped.

## 8. Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `FACTORY_APPROVAL_TTL_SECONDS` | `86400` | How long a signature may sit unused before being recorded |
| `DASHBOARD_ALLOWED_ORIGINS` | derived from Host | Extra CSRF origins |
| `DASHBOARD_LOGIN_MAX_ATTEMPTS` | `5` | Failures before backoff |
| `DASHBOARD_LOGIN_WINDOW_MS` | `900000` | Throttle window |

## 9. What did not change

Per the campaign constraints: pipeline gates, stage ordering, independence
rules, and founder merge authority are untouched. Correct one-click approval
still resumes exactly the intended task or objective.

## 10. Independent security review

This change was reviewed by an independent agent that did not write it, per
AGENTS.md ("a model cannot be the sole reviewer of its own implementation").

The reviewer built an HTML5-faithful tokenizer and fuzzed **300,000 inputs**
through the sanitizer, asserting that every tag a real browser would find in the
output is allowlisted with inert URLs. **No bypass was found**, and the
`founderDecisions` fix was confirmed complete by execution.

It did confirm eight defects, all of which are fixed here and locked down by
`factory/test/security-review-regressions.test.mjs`:

| Finding | Severity | Fix |
| --- | --- | --- |
| Approval TTL deadlocked long pipelines with no way to re-approve | HIGH | TTL now bounds the signing window only |
| Authority key readable from the record it protects | HIGH | **Fixed** — the gate now verifies against an external anchor (§3.1) |
| CI ran none of the browser-hardening tests | MEDIUM | Workflow installs dashboard deps and fails on any skip |
| Link text was interpolated unescaped | MEDIUM | Inner tokens are parsed, never raw text |
| Audit redaction was exact-name-only | MEDIUM | Substring matching + free-text scrubbing |
| `x-forwarded-host` trusted regardless of proxy config | MEDIUM | Honoured only when `DASHBOARD_TRUST_PROXY=1` |
| A link title containing `rel=` suppressed link hardening | LOW | Fallback tests emitted attribute names |
| Agent markdown could beacon the founder via remote images | LOW | `img-src 'self' data:` |

## 11. Second independent review (of #162)

The follow-up PR was itself independently reviewed. That review **found the
anchor did not work in production** — it was wired into one call path — and
demonstrated a high-risk task releasing on an attacker-supplied key with
`assertReleaseReady` passing. It also found that an unreadable anchor silently
downgraded the gate, that a symlink was followed, and that the audit refactor had
**regressed**: the field literally named `key` was no longer redacted.

All of it is fixed here and covered by
`factory/test/anchor-review-regressions.test.mjs`, whose central test calls the
gate with **no options argument at all** — the exact shape production uses.

It confirmed clean: the sanitizer's `renderer.link` fix (18 payloads, no raw HTML
via `parseInline`), the `rel`/`target` fallback, the TTL semantics in both
directions, the type-confusion guards, `injected` unreachability from task state,
and that the anchor tests fail correctly when the fix is reverted.

Still open, recorded rather than hidden: per-task revocation entries remain plain
task state and can be removed by the same write primitive.
