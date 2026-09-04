# Mini-PC Setup

This setup assumes the mini PC is the always-on orchestration host and project repositories are cloned locally on that machine.

## 1. Pull the factory branch

```bash
git fetch origin
git switch factory-v1
npm run setup
```

Run the read-only readiness check:

```bash
bash scripts/factory-doctor.sh
```

## 2. Enable OpenClaw external harness support

OpenClaw's ACP runtime is the clean route for external coding harnesses such as Claude Code and Cursor.

```bash
openclaw plugins install @openclaw/acpx
openclaw config set plugins.entries.acpx.enabled true
```

Then open OpenClaw and run:

```text
/acp doctor
```

Do not continue until ACP is healthy.

## 3. Authenticate coding harnesses on the mini PC

Install/authenticate each tool using your existing accounts/subscriptions.

### Codex
Confirm:
```bash
codex --version
```

Prefer OpenClaw's native Codex route for normal orchestration. Explicit ACP Codex is a fallback when ACP behavior is specifically useful.

### Claude Code
Confirm:
```bash
claude --version
```

Claude Code supports non-interactive runs, but the factory should normally let OpenClaw own session lifecycle rather than scattering raw CLI processes everywhere.

### Cursor CLI
Confirm:
```bash
agent --version
```

Current Cursor CLI can run non-interactively and supports worktrees. Use it primarily for UI/product implementation and visual QA.

## 4. Clone project repositories

Give the mini PC a predictable workspace. Example:

```text
~/factory/
  hq/                         # this repository
  projects/
    lifemax/
    another-project/
  worktrees/                  # disposable task workspaces
```

Each coding task must operate in its own branch/worktree. Never let multiple builder agents share a writable workspace.

## 5. GitHub authentication

Install/authenticate GitHub CLI if you want local agents to create issues/PRs:

```bash
gh auth status
```

Use the minimum permissions required. Do not put tokens in this repository.

## 6. First ACP experiments

From an OpenClaw conversation, try controlled one-shot tasks in a project repo:

```text
/acp spawn claude --mode oneshot --thread off --cwd /home/YOU/factory/projects/lifemax
```

Ask for a read-only architecture review first.

## 6a. Initialize a factory task

Create a JSON task contract with these required fields: `id`, `issue`,
`outcome`, `acceptanceCriteria`, `project`, `workType`, and `risk`. Then run:

```bash
node scripts/factory-task.mjs init --contract /path/to/task.json --repo /path/to/project
```

Runtime state is stored in the HQ's ignored
`dashboard/backend/data/factory/<project>/` directory. The isolated worktree
defaults to a sibling `.openclaw-worktrees/` directory beside the target
project. Both locations can be overridden with `--state-root` and `--worktree`.

OpenClaw automations should use the JSON adapter rather than parsing the
human-oriented CLI output:

```bash
printf '%s' '{"version":1,"action":"run-one","statePath":"/path/from/init/state.json"}' \
  | npm run --silent factory:openclaw
```

Ensure the agent IDs in `factory.config.json` exist on the host (`openclaw
agents list`). Each invoked agent receives an absolute handoff path, assigned
worktree, and a versioned result-file contract. Run `run-one` again only when
the response remains `active`; stop on `blocked` or `merge-ready`.

For normal use, submit `action: "start"` with `repo` and a natural-language
`objective`; the Chief of Staff creates the contract and the adapter drives all
seven stages. Use `action: "run"` to finish an initialized task. Runtime errors
retry the same role, while substantive review/QA/security findings route back
to the original builder with downstream evidence invalidated.

### Founder approval authority

High-risk tasks use Ed25519 signatures so a task contract or agent cannot claim
founder approval. Generate the key pair outside the repository and outside the
OpenClaw workspace, restrict the private key to the founder account, and expose
only the public-key path to the factory process:

```bash
openssl genpkey -algorithm Ed25519 -out /private/operator/factory-founder.key
openssl pkey -in /private/operator/factory-founder.key -pubout -out /etc/openclaw/factory-founder.pub
export FACTORY_FOUNDER_PUBLIC_KEY=/etc/openclaw/factory-founder.pub
```

When a high-risk task blocks before `builder`, place the human decision record
inside the worktree, sign the task-specific random challenge, then ingest it:

```bash
node scripts/factory-sign-approval.mjs \
  --state /path/to/state.json \
  --evidence evidence/founder-approval.md \
  --private-key /private/operator/factory-founder.key \
  --output /private/operator/issue-42-approval.json

node scripts/factory-task.mjs approve \
  --task issue-42 --repo /path/to/project \
  --assertion /private/operator/issue-42-approval.json \
  --evidence evidence/founder-approval.md
```

Do not put either key or signed private decision artifacts in this repository.
The OpenClaw service should not have permission to read the private key.

Then test Cursor similarly for a small UI inspection. For Codex, prefer the native `/codex` path when enabled; use explicit ACP only if you intentionally want ACP session semantics.

## 7. Keep V1 permissions conservative

Before automation, prove the loop manually:

`issue -> isolated workspace -> builder -> PR -> different-model review -> QA -> founder merge`

Do not give the dispatcher production deployment, secret rotation, billing, destructive database, or direct-main permissions.

## 8. The first success condition

The factory is ready for V2 when you can hand it a small GitHub issue and receive a good PR + independent review without answering implementation-level questions.
