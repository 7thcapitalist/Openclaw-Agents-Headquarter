# Headquarters control plane

The public half of SFD-2026-012. This directory is the **only** deployable part
of the repository, and it is deliberately not the repository root.

## What this is not

It is not Headquarters. HQ spawns `openclaw` and `pm2`, drives git worktrees on
disk and reads a local SQLite database; Vercel is serverless and can do none of
those things. Pointing Vercel at the repository root produced a build that found
no framework, emitted zero files, and deployed them green — a URL that returned
`404 NOT_FOUND` on every path while reporting success.

This is a small viewer for a projection that the factory machine publishes
outbound. It never reaches the machine, and the machine never accepts a
connection from it.

## Why there is no framework

The existing dashboard frontend is vanilla HTML, CSS and JavaScript
(`dashboard/backend/public/`). This matches it: no dependencies, no lockfile, no
third-party provenance surface, and nothing to keep upgraded. The renderer in
campaign node #189 consumes a JSON snapshot, which needs no framework either.

## Boundaries this directory must keep

- nothing here imports from `dashboard/` or `factory/` — the deployable tree is
  self-contained, enforced by `factory/test/control-plane-shell.test.mjs`
- no company data and no credential is committed here
- the repository root stays non-deployable

## Build

`npm run build` verifies the deployable output rather than generating it. A
static app has nothing to compile, but it does have something worth checking:
that the output exists at all. The build fails on an empty or incomplete output,
so the deployment that started this campaign cannot recur silently.

```
cd control-plane && npm run build
```

## Local preview

```
cd control-plane && npm start
```

Serves `public/` on `http://127.0.0.1:3212` with the same no-store headers the
deployment sets. Node's standard library only; nothing to install.

## Deployment

Vercel project `openclaw-agents-headquarter`, **Root Directory `control-plane`**.
That setting is what keeps the repository root out of the deployment; without it
Vercel reads the root again and deploys nothing.
