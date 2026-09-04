# Intelligence Layer — Phase 1 Implementation Plan: Project Context Layer

Status: Ready for implementation
Date: 2026-09-03
Companion to: `docs/software-factory/INTELLIGENCE_LAYER_PROPOSAL.md` (§3, §4, §5, §9, §12 Phase 1)
Scope of this document: **Phase 1 only.** Phases 2–4 (decision protocol, sensors, digest)
are described in the proposal and are explicitly out of scope here.

This plan is written so the next agent can implement Phase 1 without re-deriving the
architecture. Every new module has a fixed path, a fixed export surface, and a test
list. Nothing in the workflow engine changes.

---

## 0. Phase 1 goal in one sentence

Every stage handoff an agent receives is prefixed with a deterministic, budgeted,
secret-scrubbed **Context Pack** = `factory context + project context + task context`,
sourced from per-project canonical files resolved through a committed project registry.

Success check: `npm run test:factory` stays green, `npm run factory:smoke` still reaches
`merge-ready`, and `node scripts/factory-context.mjs` can `scaffold`, `show`, and `lint`
a project's context.

---

## 1. Current architecture inspection

### 1.1 How agents receive instructions today

```
founder objective
  │
  ▼
natural-language-intake.createContractFromObjective()
  → OpenClaw `main` agent (Chief of Staff) returns a task contract JSON
  → written to <stateRoot>/intake/<task-id>.json
  │
  ▼
task-initializer.initializeTask()
  → git worktree add -b factory/<task-id>  (isolated checkout of the project repo)
  → writeState(<stateRoot>/tasks/<task-id>/state.json)
  → writeHandoff()  ── first handoff-product.md
  │
  ▼   (per stage, driven by openclaw-factory.mjs / openclaw-runner.mjs)
openclaw-protocol.prepareDispatch()
  → writeHandoff({ hqRoot, statePath, state, resultPath, dispatchId })
      composes <stateRoot>/tasks/<task-id>/handoff-<stage>.md from:
        • task.outcome, task.acceptanceCriteria, task.constraints
        • state.founderDecisions (last 3)
        • completed handoffs (passed stages + evidence)
        • returned findings (last 3 failed dispatches)
        • ROLE PROMPT: factory/prompts/<stage>.md   ← the only "instructions" file
        • execution boundary + machine result contract (write JSON to resultPath)
  │
  ▼
openclaw-runner.executeOpenClaw()
  → `openclaw agent --agent <id> --session-key ... --message-file handoff-<stage>.md --json`
      run with cwd = state.worktree
      <id> resolved from factory.config.json openclawIntegration.agentIds
           by "stage:actor" → "stage" → "actor" → actor
  │
  ▼
agent works inside the worktree, writes evidence files + the result JSON
  │
  ▼
openclaw-protocol.ingestResult()
  → verifyEvidence() (must be non-empty files inside the worktree)
  → completeStage() / routeStageFailure()
```

**Key fact:** the *only* thing an agent reads as instructions is
`handoff-<stage>.md`. Everything else it knows, it reads from the worktree
filesystem itself. The worktree is a full checkout of the project repo on the
task branch, so anything committed to the project repo (including a new
`context/` directory) is already on disk for the agent — the Context Pack's job
is to *summarise it and point at it*, not to be the only copy.

### 1.2 Where context injection must happen

**`factory/lib/handoff.mjs` → `writeHandoff()`.** It is the single chokepoint.
Every code path that hands work to an agent calls it:

| Caller | File | When |
| --- | --- | --- |
| `initializeTask` | `factory/lib/task-initializer.mjs` | initial `product` handoff |
| `prepareDispatch` | `factory/lib/openclaw-protocol.mjs` | every stage dispatch (with `resultPath` + `dispatchId`) |
| `resume` / `approve` | `scripts/openclaw-factory.mjs` | after a blocker clears |
| `handoff` / `complete` / `resume` | `scripts/factory-task.mjs` | manual CLI operation |
| `resolveFounderDecision` | `dashboard/backend/lib/founderControlPlane.mjs` | founder answers a `decision-required` block |

Injecting at `writeHandoff()` therefore covers 100% of dispatch paths with
**zero changes** to the state machine, the dispatch protocol, the runner, the
JSON adapter, or the request/result schemas.

`writeHandoff()` already receives `hqRoot` and the full `state` (which carries
`state.repo`, `state.worktree`, `state.task.project`, `state.currentStage`,
`state.assignments`). No signature change is needed.

### 1.3 Where the project registry lives

**`factory/projects.json`** — committed, sibling of `factory/factory.config.json`.

Rationale:

- It is factory-global capability configuration, same tier as
  `factory.config.json`. It must be version-controlled and reviewable.
- It must be readable by `factory/lib/*` with no dependency on the dashboard or
  on the gitignored `dashboard/backend/data/` runtime tree.
- It is the *index of all projects*; it cannot live inside any one project repo
  (a project cannot enumerate its siblings).
- It must **not** live under `dashboard/backend/data/` (gitignored, per-machine,
  runtime-only). `founderControlPlane.mjs`'s `control-plane.json` stays where it
  is and keeps owning pause/resume + the ask-a-question log; the two files do
  not overlap.

Access is only through `factory/lib/context/registry.mjs`. The dashboard may
read `factory/projects.json` later, but the intelligence layer owns it.

### 1.4 What must NOT change in Phase 1

Hard invariants. If a change seems to require touching any of these, stop and
re-scope.

- **State machine** — `STAGES`, `createState`, `completeStage`,
  `routeStageFailure`, `resumeState`, and every evidence / independence /
  founder-approval invariant in `factory/lib/task-workflow.mjs`.
- **Dispatch protocol** — `prepareDispatch`, `markDispatchRunning`,
  `ingestResult`, `failDispatch`, dispatch idempotency, the `.lock` file,
  `PROTOCOL_VERSION`, and `factory/schemas/agent-result.schema.json`.
- **JSON adapter surface** — `scripts/openclaw-factory.mjs` actions
  (`start/init/next/run/run-one/ingest/resume/approve/status`) and
  `factory/schemas/openclaw-request.schema.json`. Phase 1 ships a **separate**
  adapter (`scripts/factory-context.mjs`); it does not extend the existing one.
- **`writeHandoff()` signature** — stays `{ hqRoot, statePath, state, resultPath?, dispatchId? }`.
- **Role prompts** — `factory/prompts/*.md` are untouched in Phase 1.
- **`factory.config.json`** — untouched in Phase 1 (Phase 2 adds the decision
  protocol binding).
- **`./run.sh` execution boundary** (SFD-2026-005), worktree isolation /
  one-writer-per-branch, human-merge (SFD-2026-003).
- **Repo vs private OpenClaw state split** (SFD-2026-004) — context files are
  sanitised and committed to the *project* repo; they are never private
  workspace state. The redaction guard enforces this.
- **Dependencies** — `factory/lib/*` imports Node builtins only (`fs`, `path`,
  `crypto`, `child_process`, `util`). Phase 1 adds **no** npm dependency
  anywhere. Schema validation is hand-rolled in the style of
  `validateTaskContract` / `validateAgentResult`; the `*.schema.json` files are
  the reference contract, not a runtime dependency.
- **`dashboard/backend/*`** — untouched in Phase 1.

---

## 2. Phase 1 design

### 2.1 Module map (all new unless noted)

```
factory/
  projects.json                         NEW  project registry (data)
  context/
    FACTORY.md                          NEW  global factory context (prose)
    DECISION_PROTOCOL.md                NEW  founder escalation contract (prose; machine form is Phase 2)
  schemas/
    projects.schema.json                NEW  registry contract (reference)
    ownership.schema.json               NEW  ownership.json contract (reference)
  templates/
    project-context/
      README.md                         NEW  explains the layout
      PROJECT.md                        NEW  template
      VISION.md                         NEW  template
      ROADMAP.md                        NEW  template
      DECISIONS.md                      NEW  template (SFD format)
      MEMORY.md                         NEW  template
      TECH_CONTEXT.md                   NEW  template
      USERS.md                          NEW  template
      ownership.json                    NEW  template
  lib/
    context/
      registry.mjs                      NEW  resolve project key -> repo + contextDir
      redact.mjs                        NEW  secret filename + value guards (pure)
      schema.mjs                        NEW  hand-rolled validators for registry + ownership
      assemble.mjs                      NEW  build the Context Pack (the core)
    handoff.mjs                         MODIFY  prepend the Context Pack
  test/
    context-registry.test.mjs           NEW
    context-redact.test.mjs             NEW
    context-assemble.test.mjs           NEW
    context-handoff.test.mjs            NEW
    factory-context-cli.test.mjs        NEW
scripts/
  factory-context.mjs                   NEW  JSON adapter: scaffold | show | lint | list
package.json                            MODIFY  add "factory:context" script
context/                                NEW  the factory's OWN project context dir (scaffolded)
  PROJECT.md VISION.md ROADMAP.md DECISIONS.md MEMORY.md TECH_CONTEXT.md USERS.md ownership.json
```

### 2.2 `factory/lib/context/registry.mjs`

Pure resolution over `factory/projects.json`. Node builtins only.

```js
// Path to the registry file.
export function registryPath(hqRoot)            // -> join(hqRoot, "factory", "projects.json")

// Read + validate. Throws on malformed file (missing `version`, `projects` not array,
// entry missing `key`/`repo`). Missing file -> { version: 1, projects: [] } (no throw).
export function readRegistry(hqRoot)            // -> { version, projects: RegistryEntry[] }

// Look up one entry by key. Returns the entry or null.
export function resolveProject(hqRoot, key)     // -> RegistryEntry | null

// Resolve an entry's `repo` to an absolute path:
//   "."         -> resolve(hqRoot)
//   "~/x"       -> expandHome
//   "/abs/x"    -> as-is
//   "rel/x"     -> resolve(hqRoot, "rel/x")
export function resolveRepoPath(hqRoot, entry)  // -> absolute string

// The seam helper handoff.mjs / assemble.mjs use. Never throws.
//   - registered key   -> the real entry
//   - unknown key      -> synthetic { key, name: key, repo: state.repo, contextDir: null, status: "unregistered" }
export function resolveProjectForState(hqRoot, state) // -> RegistryEntry (real or synthetic)
```

`RegistryEntry` = `{ key, name, repo, contextDir, status }`.
`contextDir` is a repo-relative path (e.g. `"context"` or `"docs/software-factory"`),
or `null` for unregistered projects (assembler then skips project-file reads).

### 2.3 `factory/lib/context/redact.mjs`

Pure. No I/O. Used by `assemble.mjs` before any fragment enters the pack, and by
`factory-context.mjs` before printing.

```js
export const SECRET_FILENAME_PATTERNS  // [/^\.env(\.|$)/i, /\.pem$/i, /\.key$/i, /^id_rsa/i,
                                       //  /(^|[._-])credentials?([._-]|$)/i, /(^|[._-])secrets?([._-]|$)/i]

export const SECRET_VALUE_PATTERNS     // named list, each { name, re }:
                                       //  aws-akia   /\bAKIA[0-9A-Z]{16}\b/
                                       //  openai-sk  /\bsk-[A-Za-z0-9]{20,}\b/
                                       //  gh-token   /\bgh[pousr]_[A-Za-z0-9]{20,}\b/
                                       //  bearer     /\bBearer\s+[A-Za-z0-9._\-]{20,}/
                                       //  pem-block  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/
                                       //  db-url     /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?):\/\/[^\s/@]+:[^\s/@]+@/

export function isSecretFilename(name)          // -> boolean

// Replace every match with "[redacted: <name>]". Returns scrubbed text + hit report.
export function scrubText(text)                 // -> { text: string, hits: Array<{ name, count }> }

// Resolve `candidate` and assert it is inside `baseDir` (defends "../.." and
// absolute escapes). Throws Error("path escapes context dir: ...") otherwise.
export function assertInsideDir(baseDir, candidate) // -> resolved absolute path
```

Notes:

- `scrubText` is intentionally conservative (a few false positives are
  acceptable; a leaked key is not).
- Entropy heuristics are **not** included in Phase 1 — pattern list only, to
  keep it deterministic and cheap. Flag as a Phase 3 refinement.

### 2.4 `factory/lib/context/schema.mjs`

Hand-rolled validators, mirrors `validateTaskContract`. No dependency.

```js
export function validateRegistry(value)   // -> value | throws Error("registry: <field> ...")
export function validateOwnership(value)   // -> value | throws Error("ownership: <field> ...")
export function isOwnershipShape(value)    // -> boolean (non-throwing, for lint)
```

Registry rules: `version === 1`; `projects` is an array; each entry has
non-empty string `key` matching `^[a-z0-9][a-z0-9-]*$`, non-empty string `repo`;
optional `name` (string), `contextDir` (string, no leading `/`, no `..`
segment), `status` in `{active, paused, archived}` (default `active`); `key`
values are unique.

Ownership rules: see §2.9 schema. Validator checks `version === 1`, `mission`
non-empty string, `successMetrics`/`currentPriorities`/`risks` arrays of the
declared shape, `openDecisions` array of strings, `responsibleAgents` an object
of string→string. Unknown top-level keys are allowed (forward-compatible) but
reported by `isOwnershipShape` diagnostics.

### 2.5 `factory/lib/context/assemble.mjs` — the core

```js
export const SECTION_BUDGETS = {          // characters, tune during implementation
  factory: 1200,
  projectSummary: 1600,
  vision: 600,
  roadmap: 500,
  techContext: 900,
  users: 500,
  memory: 900,
  decisions: 900,
};

export const CONTEXT_FILES = [
  "PROJECT.md", "VISION.md", "ROADMAP.md", "DECISIONS.md",
  "MEMORY.md", "TECH_CONTEXT.md", "USERS.md",
];

/**
 * Build the Context Pack for one task state. Pure aside from reading files under
 * hqRoot/factory/context and state.worktree/<contextDir>. NEVER throws for
 * missing files, unregistered projects, or unreadable context — it degrades and
 * records a warning. It MAY throw only for a structurally broken
 * factory/projects.json (that is a real misconfiguration the founder must fix),
 * and handoff.mjs catches even that (see §2.6).
 *
 * @returns {{ text: string, sections: Record<string,string>, warnings: Array<{code,message}> }}
 */
export function assembleContextPack({ hqRoot, state, now = new Date() });
```

Behaviour:

1. **Factory section** — first paragraph of `factory/context/FACTORY.md` (if
   present) + from `factory/factory.config.json`: `mode`,
   `prohibitedAutonomousActions` (comma-joined), `requiredGates` (comma-joined)
   + a fixed pointer line: `Full decision protocol: factory/context/DECISION_PROTOCOL.md`.
   All builtin reads; config already read elsewhere so failure here => warning
   `factory-context-unreadable`, section still emitted with the static pointer.

2. **Project section** — `resolveProjectForState(hqRoot, state)`:
   - `contextDir === null` (unregistered) → emit one line
     `- Project "<key>" is not registered in factory/projects.json — running with task context only.`
     + warning `project-unregistered`. Skip all file reads.
   - else `base = assertInsideDir(state.worktree, join(state.worktree, entry.contextDir))`:
     - `ownership.json` → `validateOwnership`; render `mission`, up to 4
       `successMetrics` as `name: current → target (asOf)`, up to 4
       `currentPriorities` titles, up to 4 `risks` as `title [severity]`,
       `openDecisions` as raw IDs (Phase 2 will expand to titles),
       `responsibleAgents` as `role=agent` pairs. Missing/invalid → warning
       `ownership-missing` / `ownership-invalid`, render `- ownership.json: <reason>`.
     - `VISION.md` → `firstParagraph()`, budget `vision`.
     - `ROADMAP.md` → the section under a heading matching `/current|now|in progress/i`,
       else first `##` block; budget `roadmap`. Label it `Current milestone`.
     - `TECH_CONTEXT.md` → section under `/constraints|do not|guardrails/i`, else
       first paragraph; budget `techContext`.
     - `USERS.md` → first paragraph + first bullet under `/sensitiv|privacy|consent/i`
       if present; budget `users`.
     - `MEMORY.md` → `lastBullets(md, 6)`; budget `memory`.
     - `DECISIONS.md` → `lastHeadings(md, 5)` (the `##` lines); budget `decisions`.
   - Always end the project section with:
     `Full context files are in your worktree at: <contextDir>/`
   - Every fragment passes through `scrubText`; any hit → warning
     `secret-redacted:<file>` and the scrubbed text is used.
   - Any single file read error → warning `context-file-unreadable:<file>`,
     skip that file, continue.

3. **Assembly** — join sections under fixed `##` headings (see proposal §5.2 for
   the exact shape). Prepend nothing else; the caller places it.

4. **Determinism** — with a fixed `now` and fixed file contents the output is
   byte-identical. `now` is only used for a relative-staleness note if a file's
   `asOf`/mtime is old; keep it out of the hot path if simpler.

Digest helpers live in the same file (not exported unless a test needs them):
`firstParagraph`, `sectionByHeading`, `lastBullets`, `lastHeadings`,
`truncateToBudget` (appends `… (truncated — see <path>)`).

### 2.6 `factory/lib/handoff.mjs` integration (the only engine-file change)

Add the import and one guarded block. Insert the pack **after** the header lines
(`Assigned harness` … `Issue:`) and **before** `## Outcome`.

```js
import { assembleContextPack } from "./context/assemble.mjs";
// ...
let contextBlock = "";
try {
  contextBlock = assembleContextPack({ hqRoot, state }).text + "\n";
} catch (err) {
  contextBlock =
    "## Project & factory context\n\n" +
    `- context assembly unavailable: ${err.message}\n` +
    "- proceed using the task context below; report this in your summary.\n\n";
}
// ... insert `contextBlock` into `body` between the header and `## Outcome`
```

Guarantees:

- Handoff generation **never** fails because context is missing or
  misconfigured. A broken `factory/projects.json` degrades to a one-line note,
  it does not block dispatch.
- Existing assertions still hold: `handoff-<stage>.md` still contains
  `Assigned harness: <actor>`, the role prompt, the execution boundary, and
  (when `resultPath` is passed) the `dispatchId` and machine result contract.

### 2.7 `factory/projects.json` (Phase 1 content)

Register only the factory itself. LifeMaxing / CampusCart are a one-line edit
each once their local repo paths are confirmed (open decision — see §7).

```json
{
  "version": 1,
  "projects": [
    {
      "key": "openclaw-factory",
      "name": "OpenClaw Agents Headquarter",
      "repo": ".",
      "contextDir": "context",
      "status": "active"
    }
  ]
}
```

`contextDir: "context"` (a new top-level dir in this repo), **not**
`docs/software-factory`, so every project — the factory included — uses the same
canonical layout. The factory's `context/PROJECT.md` and `context/TECH_CONTEXT.md`
link out to the deeper `docs/software-factory/*` documents for detail;
`context/DECISIONS.md` states that `docs/software-factory/DECISIONS.md` remains
the canonical factory decision log and mirrors nothing. `docs/software-factory/`
is not moved or edited.

### 2.8 Context file templates (`factory/templates/project-context/`)

Each `.md` template: a top HTML comment stating purpose + who maintains it, a
fixed section skeleton, and `<!-- fill: ... -->` prompts. `DECISIONS.md` uses the
SFD format already in `docs/software-factory/DECISIONS.md` (stable ID, date,
status, decision, rationale, consequences, supersession). `ownership.json`
template is the §2.9 shape populated with `"TODO"` / empty arrays. `README.md`
explains the layout, the prose-vs-`ownership.json` authority rule, and the
"agents propose via the task PR only" rule.

### 2.9 Data schemas

**`factory/schemas/projects.schema.json`** (reference; runtime validation is
`schema.mjs`). Draft 2020-12, same style as existing schemas.

```
version            const 1
projects[]         object:
  key              string  ^[a-z0-9][a-z0-9-]*$   (required, unique)
  name             string                          (optional)
  repo             string  non-empty               (required; ".", "~/...", abs, or repo-rel)
  contextDir       string  no leading "/", no ".." segment   (optional; default "context")
  status           enum ["active","paused","archived"]        (optional; default "active")
additionalProperties: false at both levels
```

**`factory/schemas/ownership.schema.json`**

```
version              const 1
mission              string non-empty                          (required)
successMetrics[]     { id, name, target, current, asOf }        strings; asOf = ISO date
currentPriorities[]  { id, title, rationale }
risks[]              { id, title, severity: low|medium|high,
                       likelihood: low|medium|high,
                       mitigation, owner }
openDecisions[]      string                                     (decision IDs; opaque in Phase 1)
responsibleAgents    object<string,string>                      (role -> agent key)
additionalProperties: true at top level (forward-compatible), false inside array items
```

No `finding.schema.json` in Phase 1 — `factory-context.mjs lint` returns an
ad-hoc `{ findings: [{ code, file, severity, message }] }` shape. The formal
finding schema arrives with the sensors in Phase 3.

### 2.10 `scripts/factory-context.mjs` (JSON adapter)

Mirrors `scripts/openclaw-factory.mjs` I/O: reads one JSON request from stdin
(or `--request <file>`), writes one JSON response to stdout, exit 1 on error.
`hqRoot` is derived from the script location like `openclaw-factory.mjs`.

| action | request fields | does | response |
| --- | --- | --- | --- |
| `list` | — | registry entries + resolved repo path + which `CONTEXT_FILES` / `ownership.json` exist | `{ version:1, projects:[{ key, repo, contextDir, files:{ "PROJECT.md":true, ... } }] }` |
| `scaffold` | `project` | copy every template into `<repo>/<contextDir>/` that does not already exist; never overwrite | `{ version:1, created:[...], skipped:[...], dir }` |
| `show` | `project`, `statePath?` | if `statePath`: load that state. else synthesise `{ repo, worktree: <resolved repo>, task:{ project, outcome:"(preview)", acceptanceCriteria:[], constraints:[] }, assignments:{ product:"openclaw" }, currentStage:"product", stages:{}, founderDecisions:[] }`. Print `assembleContextPack(...).text` + `warnings`. | `{ version:1, text, warnings }` |
| `lint` | `project`, `stalenessDays?` (default 45) | for each `CONTEXT_FILES` entry + `ownership.json`: exists? non-empty? `mtime` older than `stalenessDays`? `ownership.json` passes `isOwnershipShape`? | `{ version:1, findings:[{ code, file, severity, message }] }` |

`lint` finding codes: `missing`, `empty`, `stale`, `ownership-invalid`,
`project-unregistered`, `context-dir-missing`.

`package.json`: add `"factory:context": "node scripts/factory-context.mjs"`.

---

## 3. Files to create / modify

### Create

| Path | Kind | Notes |
| --- | --- | --- |
| `factory/projects.json` | data | registry; factory entry only (§2.7) |
| `factory/context/FACTORY.md` | prose | distil from `docs/software-factory/PROJECT_CONTEXT.md` intro + `factory.config.json` policy |
| `factory/context/DECISION_PROTOCOL.md` | prose | distil from `docs/software-factory/OPERATING_RULES.md` (escalate / do-not-escalate / risk levels). Machine form is Phase 2. |
| `factory/schemas/projects.schema.json` | reference | §2.9 |
| `factory/schemas/ownership.schema.json` | reference | §2.9 |
| `factory/templates/project-context/README.md` | prose | layout + rules |
| `factory/templates/project-context/PROJECT.md` | template | |
| `factory/templates/project-context/VISION.md` | template | |
| `factory/templates/project-context/ROADMAP.md` | template | |
| `factory/templates/project-context/DECISIONS.md` | template | SFD format |
| `factory/templates/project-context/MEMORY.md` | template | |
| `factory/templates/project-context/TECH_CONTEXT.md` | template | |
| `factory/templates/project-context/USERS.md` | template | |
| `factory/templates/project-context/ownership.json` | template | §2.9 shape, TODO values |
| `factory/lib/context/registry.mjs` | module | §2.2 |
| `factory/lib/context/redact.mjs` | module | §2.3 |
| `factory/lib/context/schema.mjs` | module | §2.4 |
| `factory/lib/context/assemble.mjs` | module | §2.5 |
| `scripts/factory-context.mjs` | adapter | §2.10 |
| `factory/test/context-registry.test.mjs` | test | §5 |
| `factory/test/context-redact.test.mjs` | test | §5 |
| `factory/test/context-assemble.test.mjs` | test | §5 |
| `factory/test/context-handoff.test.mjs` | test | §5 |
| `factory/test/factory-context-cli.test.mjs` | test | §5 |
| `context/PROJECT.md` …`context/ownership.json` (8 files) | data | output of `factory-context.mjs scaffold openclaw-factory`, then hand-filled from `docs/software-factory/*` |

### Modify

| Path | Change | Risk |
| --- | --- | --- |
| `factory/lib/handoff.mjs` | add 1 import + 1 guarded block that prepends the Context Pack (§2.6) | low — additive, fully guarded, covered by existing + new tests |
| `package.json` | add `"factory:context"` script | none |

### Explicitly NOT modified

`factory/lib/task-workflow.mjs`, `factory/lib/openclaw-protocol.mjs`,
`factory/lib/openclaw-runner.mjs`, `factory/lib/task-initializer.mjs`,
`factory/lib/natural-language-intake.mjs`, `scripts/openclaw-factory.mjs`,
`scripts/factory-task.mjs`, `factory/factory.config.json`, `factory/prompts/*`,
`factory/schemas/{openclaw-request,agent-result,founder-approval}.schema.json`,
anything under `dashboard/`.

---

## 4. Migration concerns

1. **State-dir key vs registry key.** Runtime state is written under
   `dashboard/backend/data/factory/<basename(repo)>/…` (see
   `task-initializer.mjs`, `natural-language-intake.defaultStateRoot`), keyed by
   `basename(repo)`, **not** by `task.project`. Phase 1 does **not** touch state
   paths. The assembler keys off `state.task.project` → registry and reads
   context from `state.worktree` — it never consults the state directory name.
   The registry `key` and the state-dir name only need to be reconciled when the
   sensors land (Phase 3); note it there, do not fix it here.

2. **Existing on-disk handoffs.** `handoff-<stage>.md` is rewritten on every
   `writeHandoff()` call (every dispatch, resume, approve). No migration script;
   the next dispatch regenerates with context.

3. **Unregistered projects must keep working.** `factory:smoke` uses project
   `factory-smoke-project`; the test suites use `sample` / `project`. None are
   in the registry. `assembleContextPack` must degrade to
   `factory context + "project not registered" note + task context` with no
   throw. This is a required test (§5).

4. **Factory-as-project scaffold vs `.gitignore`.** Root `.gitignore` ignores
   `/MEMORY.md` (anchored to root) and `memory/` / `tasks/` (any depth, dir
   only). The new files are `context/MEMORY.md` (a file, not `memory/`) and
   `context/…` (not `tasks/`) — none are matched. Verified. After `scaffold`,
   run `git status --porcelain context/` and confirm all 8 files show as
   untracked before committing.

5. **`context/DECISIONS.md` vs `docs/software-factory/DECISIONS.md`.** The
   canonical factory decision log stays at `docs/software-factory/DECISIONS.md`.
   The factory's `context/DECISIONS.md` is a short pointer to it. The assembler's
   `lastHeadings` digest for the factory project will therefore surface the
   pointer text, which is acceptable for Phase 1. (A future refinement: allow a
   registry entry to redirect one context file to an alternate path.)

6. **No API/CLI break.** `writeHandoff` signature is unchanged;
   `assembleContextPack` and `scripts/factory-context.mjs` are net-new. Nothing
   that currently calls the factory changes shape.

7. **Determinism for tests.** `assembleContextPack` takes `now` as a parameter
   so tests can pin it. Do not call `Date.now()` inside the digest helpers.

---

## 5. Tests required

All under `factory/test/`, run by `npm run test:factory`
(`node --test factory/test/*.test.mjs`). Match the existing style
(`node:test` + `node:assert/strict`, `mkdtempSync` fixtures).

### `context-registry.test.mjs`

- reads a valid `projects.json` fixture; `resolveProject` returns the entry.
- `resolveRepoPath` maps `"."` → `hqRoot`, `"~/x"` → home-expanded, `"/abs"` → itself.
- `resolveProjectForState` returns a synthetic `status:"unregistered"`,
  `contextDir:null` entry for an unknown key, using `state.repo`.
- `readRegistry` on a missing file → `{ version:1, projects:[] }` (no throw).
- `validateRegistry` throws on: `version` ≠ 1; `projects` not an array; entry
  without `key`; duplicate `key`; `contextDir` containing `..`.

### `context-redact.test.mjs`

- `isSecretFilename`: true for `.env`, `.env.local`, `id_rsa`, `server.pem`,
  `secrets.yaml`, `aws-credentials.json`; false for `TECH_CONTEXT.md`,
  `ownership.json`.
- `scrubText`: replaces an `sk-…` token, a `ghp_…` token, a `postgres://u:p@h`
  URL, and a full PEM private-key block; returns the matching `hits`; leaves
  ordinary prose untouched.
- `assertInsideDir`: returns a resolved child path; throws on `../escape` and on
  an unrelated absolute path.

### `context-assemble.test.mjs`

- **full context**: temp worktree with all 7 files + valid `ownership.json`,
  registry entry present → `.text` contains the mission, one
  `name: current → target` metric line, `Current milestone`, the first line of
  `VISION.md`, and the last `MEMORY.md` bullets; each rendered section ≤ its
  `SECTION_BUDGETS` cap; the `Full context files are in your worktree at:` line
  is present.
- **missing files**: worktree with only `PROJECT.md` → `.text` still returned,
  `warnings` contains `ownership-missing` and `context-file-unreadable:*` /
  file-specific codes, **no throw**.
- **unregistered project**: key absent from registry → `.text` has the factory
  section + the "not registered" line + task context is unaffected; no throw.
- **secret redaction**: `TECH_CONTEXT.md` contains `sk-live-abc…` → that string
  is absent from `.text`, `[redacted: openai-sk]` present, warning
  `secret-redacted:TECH_CONTEXT.md` present.
- **determinism**: two calls with the same fixtures and the same `now` produce
  byte-identical `.text`.
- **broken registry**: malformed `factory/projects.json` fixture →
  `assembleContextPack` throws (this is the one allowed throw; the handoff test
  proves it is caught).

### `context-handoff.test.mjs`

- `writeHandoff` for a state whose `task.project` is registered and whose
  `worktree` contains a `context/` dir → `handoff-<stage>.md` contains the
  `## Project & factory context` heading, the mission text, **and still**
  `Assigned harness: <actor>` + the role-prompt body + the execution-boundary
  line; when `resultPath`/`dispatchId` are passed, the `dispatchId` and the
  machine result contract are still present.
- `writeHandoff` with a deliberately broken `factory/projects.json` → the file
  is still written, contains `context assembly unavailable:`, and the dispatch
  is not blocked (function returns the path normally).
- `writeHandoff` for an unregistered project (mirrors `factory:smoke`) → file
  written, contains the "not registered" note, all pre-existing assertions from
  `task-entrypoints.test.mjs` style still hold.

### `factory-context-cli.test.mjs`

- `scaffold` into a temp repo → response `created` lists all 8 files, they exist
  on disk; a second `scaffold` → all 8 in `skipped`, none overwritten.
- `lint` on a temp context dir missing `VISION.md` and with an empty
  `ROADMAP.md` → findings include `{ code:"missing", file:"VISION.md" }` and
  `{ code:"empty", file:"ROADMAP.md" }`.
- `show` with no `statePath` for the scaffolded project → response `text` is a
  non-empty string containing `## Project & factory context`.
- `list` → includes the `openclaw-factory` entry with a `files` map.

### Regression (must stay green, no edits)

`factory/test/task-workflow.test.mjs`, `factory/test/openclaw-integration.test.mjs`,
`factory/test/task-entrypoints.test.mjs`. The three that render handoff/dispatch
text (`shared initializer …`, `dispatch packet is persistent …`,
`natural-language start …`) exercise `writeHandoff` with unregistered projects
and empty worktrees — they pass iff the graceful-degrade contract holds.

### Manual (not CI)

`npm run factory:smoke` once, if OpenClaw + a harness are authenticated on the
host: must still reach `merge-ready`. It is a live-harness check, not a gate.

---

## 6. Implementation checklist (ordered)

1. `factory/lib/context/redact.mjs` + `context-redact.test.mjs` (no deps on anything else).
2. `factory/lib/context/schema.mjs` (validators) + fold into registry test later.
3. `factory/lib/context/registry.mjs` + `context-registry.test.mjs`.
4. `factory/schemas/projects.schema.json`, `factory/schemas/ownership.schema.json` (reference docs).
5. `factory/projects.json` (factory entry only).
6. `factory/context/FACTORY.md`, `factory/context/DECISION_PROTOCOL.md`.
7. `factory/lib/context/assemble.mjs` + `context-assemble.test.mjs`.
8. Wire `assembleContextPack` into `factory/lib/handoff.mjs` (§2.6) + `context-handoff.test.mjs`.
9. Run `npm run test:factory` — confirm the 3 existing suites still pass.
10. `factory/templates/project-context/*` (8 files + README).
11. `scripts/factory-context.mjs` + `factory-context-cli.test.mjs` + `package.json` script.
12. `node scripts/factory-context.mjs` `scaffold` for `openclaw-factory`; hand-fill
    `context/*` from `docs/software-factory/*`; `git status` check (§4.4); commit.
13. `node scripts/factory-context.mjs show` for `openclaw-factory` — eyeball the pack.
14. Optional: `npm run factory:smoke`.

---

## 7. Deferred / out of scope for Phase 1

- **Decision protocol machine form** (`factory/decision-protocol.json`,
  `classify.mjs`), decision queue, `DECISIONS.md` appender — Phase 2.
- **Sensors**, question queue, `scripts/factory-sense.mjs`, founder-overview
  wiring, `finding.schema.json` — Phase 3.
- **Digest** (`scripts/factory-digest.mjs`) and model-assisted sensing — Phase 4.
- **State-dir key ↔ registry key reconciliation** — needed for sensors (Phase 3).
- **Expanding `openDecisions` IDs to titles** in the pack — needs the Phase 2
  queue; Phase 1 renders raw IDs.
- **Registry write API / `scripts/factory-context.mjs register`** — Phase 1 edits
  `factory/projects.json` by hand.
- **Adding LifeMaxing / CampusCart to the registry** — one-line edits, blocked
  only on confirming local repo paths (open decision below).
- **Entropy-based secret detection** in `redact.mjs` — pattern list only for now.

## 8. Open decisions still pending (from proposal §13)

These do not block starting Phase 1 (the factory project is self-contained), but
resolve #1 and #2 before wiring a second project:

1. Per-project context files in each project's **own repo** (recommended) vs.
   centralised under HQ.
2. Local paths for the LifeMaxing and CampusCart repos (needed for registry
   `repo` fields).
3. Sensor autonomy ceiling (Phase 3).
4. Blocking-question timeout fallback (Phase 2).
5. Decision-request SLA behaviour (Phase 2).
