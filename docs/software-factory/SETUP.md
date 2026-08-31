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

Then test Cursor similarly for a small UI inspection. For Codex, prefer the native `/codex` path when enabled; use explicit ACP only if you intentionally want ACP session semantics.

## 7. Keep V1 permissions conservative

Before automation, prove the loop manually:

`issue -> isolated workspace -> builder -> PR -> different-model review -> QA -> founder merge`

Do not give the dispatcher production deployment, secret rotation, billing, destructive database, or direct-main permissions.

## 8. The first success condition

The factory is ready for V2 when you can hand it a small GitHub issue and receive a good PR + independent review without answering implementation-level questions.