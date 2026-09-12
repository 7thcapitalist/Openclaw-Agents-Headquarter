# Deployment Capability Core — Architecture

Objective `obj-039f0f5a-deployment-capability-core`. Architect stage output.
Builder: implement against this document. Non-trivial deviations go back to the
  architect, not silently into code.

## 1. Proposed design

### 1.1 Shape and placement

Add one new capability module family, `factory/lib/deploy/`, in the exact style of
the existing `factory/lib/intel/`, `factory/lib/objective/`, and
`factory/lib/learning/` families:

- Node builtins only. No npm dependency. `fetch` (global, Node 24) and
  `node:child_process` are allowed; the `vercel` SDK, `node-fetch`, `undici`,
  `zod`, etc. are not.
- Hand-rolled validators in the `validateTaskContract` / `validateRegistry`
  style (throw `Error` with a specific message). The `*.schema.json` file is the
  reference contract, not a runtime dependency.
- Pure, deterministic, injectable seams (clock, provider, step runner) so every
  test runs offline with no shell-out and no network.
- All persisted state uses the atomic temp-file + `renameSync` pattern already in
  `task-workflow.mjs` `writeState()`. Never partial-update JSON in place.

Nothing in the 7-stage engine, dispatch protocol, JSON adapter, request/result
schemas, `writeHandoff()` signature, `./run.sh` boundary, or worktree isolation
changes. This capability is invoked *beside* the engine (founder-triggered CLI /
dashboard action), never *inside* it.

### 1.2 Modules

| File | Responsibility |
|------|----------------|
| `factory/lib/deploy/manifest.mjs` | `validateDeployManifest(value)`, `readDeployManifest(repoPath)` — load and validate `deploy.config.json` from a project repo root. |
| `factory/lib/deploy/provider.mjs` | Provider interface contract (doc), `selectProvider(manifest, { adapters, config })`, `defaultAdapters`. The only place provider choice is resolved. |
| `factory/lib/deploy/adapters/vercel.mjs` | Default adapter. Wraps the Vercel CLI behind an injected `exec` seam. Reads credentials from `process.env` only. Redacts secrets from all captured output. |
| `factory/lib/deploy/adapters/none.mjs` | Non-Vercel stub. Deterministic "provider not configured" result → `needs_founder_action`, no URL. Proves Vercel is not hard-coded and lets the pipeline degrade cleanly. |
| `factory/lib/deploy/orchestrator.mjs` | `runDeployment(...)` — build → test → deploy → smoke state machine over the five states. Persists deployment state. |
| `factory/lib/deploy/store.mjs` | `deploymentStatePath(hqRoot, projectKey)`, `readDeploymentState()`, `writeDeploymentState()` — atomic IO, one file per project. |
| `factory/lib/deploy/status.mjs` | `readDeploymentStatus({ hqRoot, projectKey })` — read-only founder-facing projection. Never throws for missing data. |
| `factory/schemas/deploy-manifest.schema.json` | Reference JSON Schema, mirrors the other `factory/schemas/*.schema.json` files. |

### 1.3 Deployment manifest schema (`deploy.config.json`, in each project repo)

```jsonc
{
  "version": 1,
  "provider": "vercel",                 // "vercel" | "none"; omitted => config default
  "build": {
    "command": "npm run build",         // required, non-empty string
    "installCommand": "npm ci",         // optional
    "outputDir": "dist",                // optional
    "rootDirectory": "."                // optional, repo-relative, no ".."
  },
  "env": [                              // DECLARATIONS ONLY — never values
    { "key": "DATABASE_URL", "required": true, "scope": "runtime", "source": "secret-store" },
    { "key": "NEXT_PUBLIC_API", "required": false, "scope": "build", "source": "env" }
  ],
  "hooks": {                            // optional migration / lifecycle hooks
    "migrate": "npm run db:migrate",
    "preDeploy": ["npm run lint"],
    "postDeploy": ["npm run db:seed:prod"]
  },
  "healthCheck": {
    "path": "/api/health",             // required, must start with "/"
    "expectStatus": 200,               // optional, default 200
    "timeoutMs": 10000                 // optional, default 10000
  },
  "smokeTest": {                        // optional; one functional request
    "path": "/api/version",
    "method": "GET",
    "expectStatus": 200,
    "bodyIncludes": "\"ok\":true"
  }
}
```

Validator rules (each a distinct thrown message):

1. Root must be an object; `version` must be `1`.
2. `provider`, when present, must be a known adapter id.
3. `build` object required; `build.command` required non-empty string.
4. `build.rootDirectory` / `build.outputDir`, when present, must be repo-relative
   strings without `..` (reuse the `contextDir` check from `intel/schema.mjs`).
5. `env` must be an array; each entry needs a non-empty `key`
   (`^[A-Z][A-Z0-9_]*$`); `scope ∈ {build, runtime, both}`; `source ∈ {env,
   secret-store}`. **Reject any entry carrying `value`, `secret`, `default`, or
   any property other than `key`/`required`/`scope`/`source`** — the manifest
   declares which variables exist, never what they are.
6. `healthCheck` object required; `healthCheck.path` required, must start `/`.
7. `smokeTest`, when present: `path` starts `/`; `method ∈ {GET, POST, HEAD}`;
   `bodyIncludes` a string.
8. `hooks.*` commands must be strings / arrays of strings.
9. Reject unknown top-level keys (closed schema, like `agent-result.schema.json`
   `additionalProperties: false`).

`readDeployManifest(repoPath)` returns `null` when the file is absent (a project
with no manifest is "not deployable", not an error) and throws on malformed JSON
or a failed validation.

### 1.4 Provider interface

An adapter is a plain object:

```js
{
  id: "vercel",
  // optional: adapter-specific manifest checks beyond the generic validator
  validateConfig(manifest) {},
  // perform the deploy; resolve with the production URL + a provider handle
  async deploy({ repoPath, manifest, env, logger }) {
    return { url, providerDeploymentId, logsUrl: null };
  },
  // optional: re-read live status for an existing deployment
  async getStatus({ providerDeploymentId, env }) {
    return { state: "READY" | "ERROR" | "BUILDING", url };
  }
}
```

`selectProvider(manifest, { adapters = defaultAdapters, config })`:

- `id = manifest.provider ?? config?.deploy?.defaultProvider ?? "vercel"`.
- `if (!adapters[id]) throw new Error(...unknown provider...)`.
- returns `adapters[id]`.

`defaultAdapters = { vercel: vercelAdapter, none: noneAdapter }`.

The orchestrator calls `selectProvider(...)` and the returned object's methods
**only**. It contains no `"vercel"` literal and no provider `switch`. A test
asserts this structurally (see §5).

### 1.5 Vercel adapter

- Real path: shell `npx vercel` through an injected `exec` seam
  (`execFile`-style), matching how the repo already shells out to `openclaw` /
  `gh`. Flow: `vercel pull` / `vercel build` / `vercel deploy --prebuilt
  --prod` → parse the deployment URL from stdout. The CLI receives credentials
  only through its process environment; credentials never appear in arguments.
- Credentials: `VERCEL_TOKEN`, `VERCEL_PROJECT_ID`, `VERCEL_ORG_ID` read from
  `process.env` (the OpenClaw secret store injects these at run time). Never from
  the manifest, never written to state, never logged. If `VERCEL_TOKEN` is
  missing the adapter throws a typed `MissingCredentialError` → orchestrator maps
  to `needs_founder_action`.
- Every captured stdout/stderr line passes through
  `factory/lib/common/redact.mjs` before it can reach `logger` or persisted
  history.
- Tests never invoke the real adapter; they pass a mock provider to the
  orchestrator.

### 1.6 `none` adapter

Returns `{ url: null, providerDeploymentId: null, notConfigured: true }` and the
orchestrator lands `needs_founder_action` with reason `"provider 'none' is a
stub — configure a real provider in deploy.config.json"`. Exists so
provider-selection is provably config-driven and non-Vercel projects fail safe.

### 1.7 Orchestrator and state machine

```
runDeployment({
  hqRoot, projectKey, repoPath,
  manifest,                       // pre-loaded, or orchestrator calls readDeployManifest
  adapters = defaultAdapters,
  config,                         // factory.config.json (for deploy.defaultProvider)
  provider,                       // injected in tests (a mock adapter)
  env = process.env,
  now = () => new Date(),
  exec,                           // injected step runner for build/test/hooks/http
  allowRealDeploy = false,        // MUST be explicitly set true to call provider.deploy()
}) -> finalState
```

States: `not_deployed` → `deploying` → (`deployed` | `failed` |
`needs_founder_action`).

Every run first loads the last persisted record (`readDeploymentState`) and
carries its durable facts forward — `provider`, `productionUrl`,
`providerDeploymentId`, `lastDeploymentAt`, last `health`, and a trimmed
`history` (last 40 entries). Run-scoped fields (`state`, `founderActionRequired`,
`founderActionReason`, `lastError`) always start clean. A missing or unreadable
prior record starts from `baseState`. This guarantees a failed or dry run never
erases the known-good production URL / timestamp / audit trail that HQ serves.

Steps, in order, each recorded to `history`:

1. **validate** — `readDeployManifest` / `validateDeployManifest`; resolve every
   `env[]` entry with `required:true` against `env`. Missing manifest or
   unresolved required var → `failed`, `lastError` names the problem.
2. **build** — run `build.installCommand` (if any) then `build.command` via
   `exec`. Non-zero exit → `failed`.
3. **test** — run the project's own test command. Convention: `npm test`
   (sk's if the project declares none via `manifest.build` — a `test` step that
   finds no test script records `skipped`, not `failed`). Non-zero → `failed`.
4. **dry-run gate** — if `!allowRealDeploy`: stop here, land
   `needs_founder_action` reason `"dry run: real deploy requires founder
   action"`. A dry run runs validate/build/test only — it never touches an
   external system.
5. **migrate hooks** — `hooks.preDeploy`, then `hooks.migrate`. Only reached
   once the founder has authorised a real deploy (`allowRealDeploy === true`),
   because these can mutate production (e.g. run migrations against a production
   `DATABASE_URL`). Failure → `failed` (before any deploy).
6. **deploy** — `provider.deploy(...)`. Adapter `MissingCredentialError` /
   auth error → `needs_founder_action`. Other adapter throw → `failed`. Success
   → record `productionUrl`, `providerDeploymentId`, set state `deploying`.
7. **postDeploy hooks** — `hooks.postDeploy`. Failure → `failed` (URL retained).
8. **smoke** — HTTP GET `healthCheck.path` against `productionUrl`, assert
   `expectStatus` within `timeoutMs`; then, if `smokeTest` present, one
   functional request asserting status and optional `bodyIncludes`. Any failure
   → `failed`, `productionUrl` and timestamp retained so the founder can inspect
   the broken deploy. `healthCheck.path` / `smokeTest.path` must be a single-`/`
   absolute path with no authority — `//host` and `/\host` are rejected by the
   manifest validator so the post-deploy request cannot be redirected to an
   external host.
9. all passed → `deployed`, set `lastDeploymentAt = now()`.

Persisted record (`store.mjs`):

```jsonc
{
  "version": 1,
  "projectKey": "lifemaxing",
  "state": "deployed",
  "provider": "vercel",
  "productionUrl": "https://lifemax.example.app",
  "providerDeploymentId": "dpl_...",
  "lastDeploymentAt": "2026-09-08T21:00:00.000Z",
  "health": { "checkedAt": "...", "ok": true, "status": 200 },
  "founderActionRequired": false,
  "founderActionReason": null,
  "lastError": null,
  "history": [
    { "at": "...", "step": "build", "outcome": "pass" },
    { "at": "...", "step": "deploy", "outcome": "pass", "detail": "dpl_..." }
  ]
}
```

`state` is written on every transition, so a crash mid-run leaves a readable
`deploying` record rather than a corrupt file.

### 1.8 Data-layer surface (existing layer only)

1. `factory/lib/deploy/status.mjs` `readDeploymentStatus({ hqRoot, projectKey })`
   → `{ state, productionUrl, health, lastDeploymentAt, founderActionRequired }`;
   returns `{ state: "not_deployed", ... }` when no file exists. Read-only, never
   throws — mirrors `factory/lib/hq/tasks.mjs`.
2. `factory/lib/hq/company-state.mjs`: add one field to each `projects[]` row —
   `deployment: readDeploymentStatus({ hqRoot, projectKey: p.key })`. Wrapped so
   a read error becomes a `warnings[]` entry, never a throw (same discipline as
   `safeBrief`). This flows out through the existing `/api/hq/company` route with
   no route change.
3. `dashboard/backend/server.mjs`: one new read-only route
   `GET /api/hq/projects/:id/deployment` → `res.json(readDeploymentStatus({
   hqRoot: ROOT, projectKey: req.params.id }))`. Matches the existing
   `/api/hq/projects/:id/...` handlers. No write route — deployment state is
   machine-written by the orchestrator only.

No change to `hqStore.mjs` project JSON (`data/hq/projects/*.json`): those are
Zod-validated and founder-editable, wrong home for machine status.

### 1.9 Storage location and key

- File: `dashboard/backend/data/factory/<repoBasename>/deployments/<projectKey>.json`.
- `<repoBasename>` is the same directory the rest of the factory uses
  (`defaultStateRoot`, `hq/tasks.mjs` `defaultStateRoot`).
- `<projectKey>` is the registry `key` (slug-validated, stable) — **not** derived
  again from the path. `store.mjs` takes `hqRoot` + `projectKey` and resolves the
  registry entry once to get the repo basename, avoiding the known
  "state-dir key vs registry key mismatch" risk.
- Directory is under the already-gitignored `dashboard/backend/data/` tree, so
  deployment state (including any URL) never enters git.

### 1.10 Configuration

- Per-project swap point: `deploy.config.json` `provider`.
- Optional global default (additive, engine ignores unknown keys):
  `factory/factory.config.json` →
  `"deploy": { "defaultProvider": "vercel", "providers": ["vercel", "none"] }`.
  `selectProvider` uses it only when a manifest omits `provider`.
- `.env.example`: append commented, value-less placeholders:
  `# VERCEL_TOKEN=`, `# VERCEL_PROJECT_ID=`, `# VERCEL_ORG_ID=`.

### 1.11 Optional CLI entry point

`scripts/factory-deploy.mjs` (mirrors `scripts/factory-objective.mjs`) +
`package.json` script `"factory:deploy": "node scripts/factory-deploy.mjs"`.
Flags: `--project <key>`, `--allow-real-deploy` (default off → dry run),
`--provider <id>` (override). This is the founder-triggered entry; it is never
added to `factory.config.json` `pipeline` or `concurrentGroups`.

## 2. Files / components affected

New:
- `factory/lib/deploy/manifest.mjs`, `provider.mjs`, `orchestrator.mjs`,
  `status.mjs`, `store.mjs`, `adapters/vercel.mjs`, `adapters/none.mjs`
- `factory/schemas/deploy-manifest.schema.json`
- `factory/test/deploy-manifest.test.mjs`, `deploy-provider.test.mjs`,
  `deploy-orchestrator.test.mjs`, `deploy-status.test.mjs`
- `docs/software-factory/DEPLOYMENT_CAPABILITY_DESIGN.md` (this file)
- (optional) `scripts/factory-deploy.mjs`
- (optional) `examples/deploy.config.json` reference manifest

Edited:
- `factory/lib/hq/company-state.mjs` — one guarded read-only field on project rows
- `factory/test/hq-company-state.test.mjs` — assert the `deployment` field
- `dashboard/backend/server.mjs` — one GET route
- `docs/software-factory/DECISIONS.md` — SFD-2026-009 (added by architect)
- (additive) `factory/factory.config.json` — `deploy` block
- (additive) `.env.example` — commented Vercel placeholders

Unchanged (explicitly): `task-workflow.mjs`, `openclaw-runner.mjs`,
`openclaw-protocol.mjs`, `handoff.mjs`, `objective/orchestrator.mjs`, all
`*.schema.json` request/result contracts, `run.sh`.

## 3. Key tradeoffs

1. **Vercel via CLI vs REST API.** CLI matches the repo's existing shell-out
   pattern (`openclaw`, `gh`), tracks Vercel's own prebuilt-deploy flow, and is
   less code to maintain; cost is a runtime dependency on the `vercel` binary and
   harder direct unit testing. REST via `fetch` is pure Node and fully mockable
   but re-implements deployment polling. **Choose CLI**, isolated behind an
   injected `exec` seam so tests never shell out.
2. **Deployment state home: factory data dir vs HQ project JSON.** The factory
   `data/` tree wins — runtime, gitignored, same atomic-write pattern, keyed like
   task state. HQ project JSON is founder-editable and Zod-gated.
3. **Key by registry `key` vs repo basename.** Use `key` for the filename
   (stable slug) but resolve the repo-basename directory from the registry entry
   in one place, so the two never drift.
4. **Deploy status in the handoff context pack.** Would serve the "every handoff
   carries context" mission, but `assembleContextPack` is deterministic and
   tested, and adding fields risks the known handoff-bloat / leak risk. **Out of
   scope**; note as a follow-up once deployment state has proven shape.
5. **One state file per project vs per deployment run.** One file per project
   with a bounded `history[]` array keeps the founder view O(1) and matches
   `deployment-status`-style questions. Full per-run logs stay with the provider
   (`logsUrl`).

## 4. Risks and failure modes

| Risk | Severity | Mitigation |
|------|----------|------------|
| Orchestrator performs a real production deploy autonomously (`production-deploy` is a prohibited autonomous action). | High | `allowRealDeploy` defaults `false`; dry run lands `needs_founder_action`; never wired into `pipeline`/`concurrentGroups`; real run is founder-triggered CLI/dashboard action. Test asserts the default. |
| A secret (token, DB URL) lands in the repo or in persisted `history`/`lastError`. | High | Validator rejects value-bearing `env[]` entries; adapter routes all captured output through `common/redact.mjs`; state lives only under gitignored `data/`; test pipes a fake `VERCEL_TOKEN` through and asserts it is absent from persisted state and status. |
| `npx vercel` / network unavailable in CI → flaky tests. | Medium | All automated tests use a mock provider and injected `exec`; no network in `npm run test:factory`. |
| npm dependency creeps into `factory/lib/deploy/*`. | Medium | Builder note: builtins + `fetch` + `node:child_process` only. Reviewer checks imports. |
| State-dir key (repo basename) vs registry key mismatch. | Medium | `store.mjs` resolves both from the registry entry in one function; filename is the slug `key`. |
| Health check returns 200 on an error page (false green). | Medium | Smoke step requires a separate functional request with asserted status and optional `bodyIncludes`, distinct from the health ping. |
| Partial/corrupt state file on crash. | Low | Atomic temp-file + `renameSync`; `state` written on every transition. |
| Manifest drift from the reference `deploy-manifest.schema.json`. | Low | `deploy-manifest.test.mjs` shape-checks the JSON Schema against the validator's accepted/rejected fixtures. |

## 5. Verification plan

Repo test command (`npm run test:factory` → `node --test factory/test/*.test.mjs`)
stays green. New tests, `node:test` + `mkdtempSync` temp-HQ style (see
`intel-registry.test.mjs`, `hq-company-state.test.mjs`):

- **`deploy-manifest.test.mjs`** — valid manifest passes; each rule in §1.3
  throws a specific message: missing `build.command`, `env[]` entry with a
  `value` property, `env[].key` not `SCREAMING_SNAKE`, `healthCheck.path` without
  leading `/`, unknown `provider`, unknown top-level key, `rootDirectory` with
  `..`. Reference-schema shape check.
- **`deploy-provider.test.mjs`** — `selectProvider({provider:"vercel"})` →
  adapter with `id:"vercel"`; `{provider:"none"}` → stub; unknown id throws;
  `provider` omitted + `config.deploy.defaultProvider:"none"` → stub. Structural
  assertion that `orchestrator.mjs` source contains no `"vercel"` literal and no
  provider `switch`/`if` (read the file, regex) — proves not hard-coded.
- **`deploy-orchestrator.test.mjs`** — with a mock provider and injected `exec`:
  - all steps pass + `allowRealDeploy:true` → `deployed`, `productionUrl` set,
    `lastDeploymentAt` set, `health.ok true`.
  - `build` exits non-zero → `failed`, `lastError` mentions build, provider
    `deploy` never called.
  - provider throws `MissingCredentialError` → `needs_founder_action`,
    `founderActionRequired:true`.
  - deploy ok, smoke request status mismatch → `failed`, `productionUrl`
    retained.
  - `allowRealDeploy` omitted → `needs_founder_action`, `provider.deploy` never
    called (autonomy guard).
  - state file is atomically written and re-readable; `history[]` append order
    is build → test → deploy → smoke.
  - fake `VERCEL_TOKEN` fed via `env` never appears in the persisted file.
- **`deploy-status.test.mjs`** — `readDeploymentStatus` returns `not_deployed`
  with no file; returns the projection from a written file; missing project key
  does not throw.
- **`hq-company-state.test.mjs`** (edit) — a project with a written deployment
  file surfaces `deployment.state` on its company-state row; a project without
  one surfaces `not_deployed`; a malformed file yields a `warnings[]` entry, not
  a throw.
- **Dashboard route** — `GET /api/hq/projects/:id/deployment` returns the
  projection (add to an existing server/lib test file or a small new one under
  `dashboard/backend`, following the local dashboard test convention).

Manual, founder-run, outside the automated suite:
`npm run factory:deploy -- --project lifemaxing` (dry run → `needs_founder_action`),
then `-- --project lifemaxing --allow-real-deploy` with real `VERCEL_*` in the
secret store; confirm the production URL and timestamp land in the status route
and the company view.

## 6. Decision Card (informational — not a blocker)

**SFD-2026-009 (proposed): deploy orchestrator is dry-run by default; a real
production deploy is a founder-triggered action, never autonomous.**

`production-deploy` is already in `factory.config.json`
`prohibitedAutonomousActions`. The recommended architecture keeps the capability
strictly within that policy: `allowRealDeploy` defaults off, the orchestrator is
never added to the engine pipeline, and the real path runs only from an explicit
founder CLI/dashboard action. Because this stays inside existing policy, the
architect is proceeding on this basis and no founder decision is required to
start the build. Flagged only so the founder can object before merge if they
want a different posture (e.g. auto-deploy to a non-production environment).
