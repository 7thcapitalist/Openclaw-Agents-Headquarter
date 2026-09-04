# Project context layer

These files are scaffolded into a project's `contextDir` (default `context/`) by
`node scripts/project-intel.mjs` with a `scaffold` request. They are the durable,
versioned intelligence layer for one project — the thing that makes every agent
working on it behave like an employee who knows the company.

## Files

| File | Owns |
| --- | --- |
| `PROJECT.md` | One-screen orientation: what this is, current status, current phase, how work flows |
| `VISION.md` | Why the product exists, the 1–2 year bet, explicit non-goals |
| `MISSION.md` | The concrete thing the team is doing now and how success is measured |
| `ROADMAP.md` | Ordered milestones, the current one, what is deferred |
| `DECISIONS.md` | Accepted durable decisions (stable IDs, rationale, consequences, supersession) |
| `MEMORY.md` | Durable non-obvious facts learned while building |
| `TECH_CONTEXT.md` | Stack, environments, constraints, an explicit "do not do" list, observability |
| `USERS.md` | Who the users are, their jobs-to-be-done, their sensitivities |
| `COMPETITIVE_CONTEXT.md` | The alternatives users have, this project's wedge, what it will not compete on |
| `ownership.json` | Machine mirror of the above: mission, metrics, priorities, risks, open decisions, responsible agents |

## Rules

- The prose files are authoritative for humans and agents to read. `ownership.json`
  is the machine-authoritative mirror. **If prose and `ownership.json` disagree,
  stop and surface it — do not guess.**
- Agents may only **propose** edits, and only through the task's own PR. Never
  edit another project's context. Never edit context outside your worktree.
- Never put secrets, credentials, tokens, or raw personal/user data in any of
  these files. The context assembler refuses secret-looking filenames and scrubs
  key material, but the files must be clean at the source.
- A missing, stale, or thin file is a finding — see
  `node scripts/project-intel.mjs` `lint`.

## How agents receive this

`factory/lib/intel/assemble.mjs` reads these files from the task worktree and
prepends a budgeted, secret-scrubbed digest to every stage handoff, as
`factory context + project context + task context`. The full files are always on
disk in the worktree for an agent to open on demand.
