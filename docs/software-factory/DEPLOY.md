# Deploying the HQ control plane

The control plane runs on the founder's machine under pm2. This is how it is
started, how it is updated, and the two traps that have already cost an outage.

## The runtime has its own checkout

```
/home/joao-vitor/hq-runtime                  ← what pm2 runs. Pinned to main.
/home/joao-vitor/Openclaw-Agents-Headquarter ← where agents work. Any branch.
```

Until 2026-09-15 there was only the second one, and pm2 ran from it. That meant
**whatever branch an agent last checked out was what production executed.** At
the moment the split was made, the live control plane was serving one agent's
in-progress feature branch, three commits behind `main`.

It was not hypothetical drift. On that day two sessions working in that one tree
committed onto each other's branches, one PR was merged carrying two unrelated
changes, and a third had to be closed because its diff against `main` had become
a revert of shipped code.

The runtime checkout is not a convenience. It is the boundary between "an agent
is working" and "the company is running".

### Rules

- pm2 points at `hq-runtime` and nowhere else.
- `hq-runtime` is only ever on `main`. Never a feature branch, never a detached
  commit, never a local edit. `git status` there should always be clean.
- Agents never work in it. Their worktrees live under `.worktrees/` in the other
  checkout.

## Deploying

```bash
cd /home/joao-vitor/hq-runtime
git pull --ff-only origin main
npm install --omit=dev --prefix dashboard/backend   # only if deps changed
pm2 reload ecosystem.config.cjs
pm2 save
```

Then verify — see "Verifying a deploy" below, because two of these processes can
fail in a way that looks exactly like success.

## The process list lives in `ecosystem.config.cjs`

Before that file existed, the answer to "how does this run" was only in pm2's
memory. Each process had been started by hand from whichever shell was open, so
it inherited that shell's environment — the live snapshot on 2026-09-15 showed
production processes carrying the `CLAUDE_CODE_SESSION_ID` and `CODEX_SESSION_ID`
of the agent sessions that happened to start them.

Worse, settings that exist **nowhere else** were only in that memory:
`HQ_AUTO_RETRY=0` is not in `.env` and not in the repo. Reading either one told
you the opposite of what was running.

A process list you cannot reconstruct is a process list you cannot restore.

Secrets stay in `.env`, which is gitignored. The ecosystem file reads it at load
time with a small parser rather than a dependency, so it works from a checkout
with nothing installed at the root, and passes each app only the variables it
actually reads — the publisher and the intent worker get the write token, the
dashboard does not.

## Trap 1: `interpreter` is required, not cosmetic

Every node app in the ecosystem file sets `interpreter: "node"`. Leave it off and
pm2 loads the script inside its own fork container.

## Trap 2: a process manager owns `argv[1]`

pm2 in fork mode does not exec the script — it imports it from its container. The
running process sees:

```
argv = ["/usr/bin/node", ".../pm2/lib/ProcessContainerFork.js", "loop"]
```

`argv[2]` is the mode. `argv[1]` is pm2's wrapper.

Any script that decides whether to run by comparing `argv[1]` to its own path
will do **nothing** under pm2 — and pm2's IPC channel keeps it alive and
`online` regardless, with an empty log. `scripts/hq-intents.mjs` had exactly this
guard and the entire founder intent pipeline was dead for six minutes before
anyone could tell, because "online with no output" is indistinguishable from
"idle, nothing queued".

Gate an entry point on its **mode**, never on `argv[1]`.

## Verifying a deploy

`pm2 list` showing `online` is not verification. Both background workers can be
online and doing nothing.

```bash
pm2 describe hq-intents | grep 'out log path'     # the id changes when recreated
```

pm2 renames log files when a process is deleted and re-added
(`hq-intents-out-11.log`, not `hq-intents-out.log`). Tailing the old path shows a
healthy-looking history from a process that no longer exists. Always resolve the
current path first.

Then, within about 30 seconds of a restart:

| Process | Expected | Empty log means |
|---|---|---|
| `hq-publisher` | `published N panel(s)` every ~30s | not publishing; console goes stale |
| `hq-intents` | `polling for founder intents every 30000ms` on start | **the worker is dead** |
| `hq-dashboard` | `dashboard http://127.0.0.1:3211 (root=…)` | check the root is `hq-runtime` |

The dashboard's boot line prints its root. If it does not say `hq-runtime`,
pm2 is running the wrong checkout.

## What a restart costs

The objective orchestrator runs **inside** the dashboard process. Restarting
`hq-dashboard` stops any objective mid-flight, and nothing re-attaches them on
boot: their nodes stay `pending` with no runner, invisible to the task-level
auto-retry sweep because they may have no task state file at all.

Before restarting the dashboard, check nothing is live:

```bash
pm2 logs hq-dashboard --lines 50 --nostream | grep -i dispatch
```

`HQ_AUTO_RETRY` is `0` deliberately — see the gate-integrity campaign, which
requires verdict attribution to land before anything retries automatically. It
is set in `ecosystem.config.cjs` and nowhere else.
