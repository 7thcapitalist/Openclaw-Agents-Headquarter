# Headquarters Dashboard — Deployment / Operations

How the HQ dashboard runs in the "always on, reachable from the internet" setup.

## What's running

| Piece | What it is | Supervisor | Bound to |
|-------|-----------|------------|----------|
| `hq-dashboard` | The Express control plane (`dashboard/backend/server.mjs`) | pm2 | `127.0.0.1:3211` (loopback only) |
| `hq-tunnel` | Cloudflare **quick** tunnel (`cloudflared`) that publishes the dashboard on the public internet | pm2 | outbound to Cloudflare edge; origin `http://127.0.0.1:3211` |

- pm2 itself is kept alive across reboots by a **systemd --user** unit: `~/.config/systemd/user/pm2-hq.service` (enabled; user lingering is on, so it starts at boot without anyone logging in).
- Both pm2 apps are defined in `dashboard/backend/ecosystem.config.cjs`. That file reads `DASHBOARD_PORT` from the repo-root `.env` — it does **not** hardcode a port.

## Public URL

This is a **quick tunnel**, so the URL is random and **changes every time `hq-tunnel` restarts**.

Find the current URL any time:

```bash
curl -s http://127.0.0.1:20241/quicktunnel
# -> {"hostname":"<something>.trycloudflare.com"}

# or from the logs:
pm2 logs hq-tunnel --lines 50 --nostream | grep trycloudflare.com
```

URL at last deploy (2026-09-05): **https://announce-plays-fireplace-heath.trycloudflare.com**

> If you want a stable URL that survives restarts (e.g. `hq.yourdomain.com`), switch to a
> *named* tunnel: `cloudflared tunnel login`, `cloudflared tunnel create hq`,
> `cloudflared tunnel route dns hq hq.yourdomain.com`, then point `hq-tunnel` at
> `cloudflared tunnel run hq` instead of the `--url` quick-tunnel command in
> `ecosystem.config.cjs` and `pm2 save`.

## Where the secrets live

`/home/joao-vitor/Openclaw-Agents-Headquarter/.env`  (repo root — **not** `dashboard/backend/.env`)

- `server.mjs` loads it via `dotenv.config({ path: join(AGENT_LAB_ROOT, ".env") })`, and
  `AGENT_LAB_ROOT` is the repo root (set by the pm2 ecosystem file and by the `npm` scripts).
- The file is gitignored (`.gitignore` line 2: `.env`) and `chmod 600`. **Never commit it.**
- Contents: `DASHBOARD_PASSWORD` (login password), `DASHBOARD_SESSION_SECRET` (session signing
  key), `DASHBOARD_PORT=3211`, `DASHBOARD_HOST=127.0.0.1`, `DASHBOARD_HTTPS=1`,
  `DASHBOARD_TRUST_PROXY=1`. The last two make the session cookie `Secure` and let
  express-session trust the `X-Forwarded-Proto` header the tunnel sends.
- The old placeholder creds (`test-pass-123` / `local-dev-secret-please-change`) were replaced
  with strong generated values on 2026-09-05, before anything was exposed publicly.

To rotate the password: edit `DASHBOARD_PASSWORD` in that `.env`, then
`pm2 restart hq-dashboard`.

## Day-to-day commands

All commands assume `pm2` is on `PATH` (`~/.npm-global/bin`). If `pm2: command not found`,
run `export PATH="$HOME/.npm-global/bin:$PATH"` first.

### Status
```bash
pm2 status                       # both processes, uptime, restart count
pm2 logs hq-dashboard            # dashboard logs (Ctrl-C to exit)
pm2 logs hq-tunnel               # tunnel logs / connection health
curl -s http://127.0.0.1:20241/quicktunnel      # current public hostname
curl -sI http://127.0.0.1:3211/login.html       # dashboard alive on localhost?
systemctl --user status pm2-hq.service          # is the boot supervisor up?
```

### Restart
```bash
pm2 restart hq-dashboard         # restart just the app (e.g. after editing .env)
pm2 restart hq-tunnel            # restart the tunnel  -> NEW public URL
pm2 restart all                  # both
```

### Stop / start
```bash
pm2 stop hq-tunnel               # take the site offline (dashboard keeps running locally)
pm2 stop all
pm2 start hq-dashboard           # start again from the saved process list
pm2 start dashboard/backend/ecosystem.config.cjs   # (re)create both from the config file
```

### After changing `ecosystem.config.cjs` or `DASHBOARD_PORT`
```bash
cd /home/joao-vitor/Openclaw-Agents-Headquarter
pm2 delete hq-dashboard hq-tunnel
pm2 start dashboard/backend/ecosystem.config.cjs
pm2 save                         # <-- important: persists the new definition for reboots
```

## Recovering after a machine reboot

Nothing manual is normally needed — `pm2-hq.service` (systemd --user, enabled, lingering on)
runs `pm2 resurrect` on boot, which restores both apps from `~/.pm2/dump.pm2`.
The public URL will be different (quick tunnel).

If it did **not** come back:
```bash
export PATH="$HOME/.npm-global/bin:$PATH"
systemctl --user start pm2-hq.service      # start the pm2 daemon + resurrect saved apps
pm2 status                                 # verify hq-dashboard + hq-tunnel are online
# still nothing? recreate from config:
cd /home/joao-vitor/Openclaw-Agents-Headquarter
pm2 start dashboard/backend/ecosystem.config.cjs && pm2 save
# get the new URL:
curl -s http://127.0.0.1:20241/quicktunnel
```

If `systemctl --user` complains there's no session bus:
```bash
loginctl enable-linger joao-vitor          # already enabled, but harmless to re-run
systemctl --user daemon-reload
systemctl --user enable --now pm2-hq.service
```

## Full teardown (undo this deployment)
```bash
export PATH="$HOME/.npm-global/bin:$PATH"
pm2 delete hq-dashboard hq-tunnel && pm2 save
systemctl --user disable --now pm2-hq.service
rm ~/.config/systemd/user/pm2-hq.service && systemctl --user daemon-reload
# (secrets in repo-root .env and the cloudflared binary in ~/.local/bin are left in place)
```

## Notes / gotchas

- **Origin binds loopback only.** `server.mjs` listens on `127.0.0.1`, so the only path in
  from the internet is through the Cloudflare tunnel. Stopping `hq-tunnel` fully closes
  public access.
- **Auth** is a single shared password (`POST /api/auth/login`) + a signed, `HttpOnly`,
  `Secure`, `SameSite=Lax` session cookie (`agentlab.sid`, 7-day expiry) stored server-side
  in SQLite. There is no rate-limiting or lockout in the app itself — keep the password
  strong (it is) and rotate it if it leaks. Cloudflare's edge sits in front for basic
  DDoS/bot absorption. For a real second factor, add Cloudflare Access on a named tunnel.
- **`better-sqlite3` must stay at `^13.x`** (native-module compatibility with this machine's
  Node v24 — older versions abort the process a few seconds to minutes after start).
- The `cloudflared` binary lives at `~/.local/bin/cloudflared` (installed from Cloudflare's
  GitHub release, not apt — no root on this box). Update with:
  `curl -fsSL -o ~/.local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x ~/.local/bin/cloudflared && pm2 restart hq-tunnel`
- pm2's metrics/quick-tunnel introspection port is `127.0.0.1:20241` (override with
  `CLOUDFLARED_METRICS_PORT` in `.env`).
