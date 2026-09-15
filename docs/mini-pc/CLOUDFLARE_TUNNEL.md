# Cloudflare tunnel — quick tunnel → named tunnel + Access

The mini PC is a headless server. The dashboard binds `127.0.0.1:3211` and the
cloudflared tunnel is the only path in from the internet, so the tunnel *is* the
front door — stopping `hq-tunnel` closes public access completely.

Today that front door is a **quick tunnel**: a random `*.trycloudflare.com`
hostname that changes on every restart, with nothing but the app's single shared
password in front of it. This upgrades it to a **named tunnel** on a stable
hostname with **Cloudflare Access** as a real second factor.

Nothing here changes how the factory runs. Rollback is one line in `.env`.

---

## Prerequisites — founder actions, one browser needed

1. **A domain on Cloudflare.** Buy it at Cloudflare Registrar (dash → Domain
   Registration). A domain bought inside Cloudflare has its zone live
   immediately; bought elsewhere you change nameservers and wait for propagation
   before `cloudflared tunnel login` can offer the zone at all. ~$10-11/yr for a
   `.com`, at cost. The name is cosmetic — the hostname becomes `hq.<domain>`.

2. **Zero Trust initialised.** First time you open Zero Trust it asks for a team
   name and a plan. Take **Free** (50 users). Access applications live under
   this, and you cannot create one until it exists.

3. **One account throughout.** The domain, the Zero Trust org, and whatever
   `cloudflared tunnel login` authenticates as must all be the same Cloudflare
   account.

> **You do not need a browser on the mini PC.** `cloudflared tunnel login`
> prints the auth URL to stdout and waits. Open that URL on your notebook,
> pick the zone there, and the cert lands back on the mini PC at
> `~/.cloudflared/cert.pem`. Driving this over SSH is the normal path.

---

## 1. Create the tunnel

```bash
export PATH="$HOME/.local/bin:$PATH"

cloudflared tunnel login                      # paste the printed URL into your notebook
cloudflared tunnel create hq                  # writes ~/.cloudflared/<UUID>.json
cloudflared tunnel route dns hq hq.<domain>   # creates the proxied CNAME
cloudflared tunnel list                       # note the UUID
```

## 2. Write `~/.cloudflared/config.yml`

Ingress rules rather than a command-line origin. This is what lets one tunnel
serve several hostnames — the mini PC will host more than the dashboard, and
adding the next one then costs two lines and a restart instead of a second
tunnel.

```yaml
tunnel: hq
credentials-file: /home/joao-vitor/.cloudflared/<UUID>.json

# Keep the metrics listener: scripts/hq-status.mjs reads it.
metrics: 127.0.0.1:20241

ingress:
  - hostname: hq.<domain>
    service: http://127.0.0.1:3211

  # Future services on this box go here, above the catch-all:
  # - hostname: lifemax.<domain>
  #   service: http://127.0.0.1:XXXX

  # Required final rule — anything unmatched gets a 404 rather than reaching a
  # service by accident.
  - service: http_status:404
```

Validate before restarting anything:

```bash
cloudflared tunnel ingress validate --config ~/.cloudflared/config.yml
cloudflared tunnel ingress rule --config ~/.cloudflared/config.yml https://hq.<domain>
```

## 3. Flip pm2 over

`ecosystem.config.cjs` builds the tunnel arguments from `.env`, so this is a
config change, not a code change. Add to the repo-root `.env`:

```bash
CLOUDFLARE_TUNNEL_NAME=hq
# optional, defaults to ~/.cloudflared/config.yml
# CLOUDFLARE_TUNNEL_CONFIG=/home/joao-vitor/.cloudflared/config.yml
```

Then:

```bash
cd /home/joao-vitor/Openclaw-Agents-Headquarter
pm2 delete hq-tunnel
pm2 start dashboard/backend/ecosystem.config.cjs --only hq-tunnel
pm2 save
```

`pm2 restart` is not enough — pm2 caches the argument list from when the process
was created, so the old `--url` arguments survive a restart. Delete and recreate.

Verify:

```bash
pm2 logs hq-tunnel --lines 20 --nostream | grep -i "registered tunnel connection"
curl -sI https://hq.<domain>/ | head -3        # expect 302 → /login.html
```

**Rollback:** comment out `CLOUDFLARE_TUNNEL_NAME`, then delete/recreate
`hq-tunnel` again. You are back on a quick tunnel.

---

## 4. Cloudflare Access — and the trap that comes with it

Zero Trust → Access → Applications → Add → Self-hosted.

- **Application domain:** `hq.<domain>`
- **Policy:** Allow · Emails · your address. One-time PIN needs no identity
  provider; wiring Google or GitHub SSO is nicer and optional.
- **Session duration:** 1 month is reasonable for a single-founder box.

### The trap: Access breaks every non-browser client

Once Access is on, anything that is not a browser session gets Cloudflare's SSO
page instead of the dashboard — an HTML login page with a `200`, which is worse
than an error because naive checks read it as success. That includes
`scripts/hq-status.mjs`, any `curl` health check, and anything scripted you add
later.

The fix is an Access **service token**, decided at the same time as the policy,
not discovered an hour later:

1. Zero Trust → Access → Service Auth → Create Service Token. Copy both halves
   **now**; the secret is shown once.
2. Add a second policy on the application: Action **Service Auth**, Include →
   Service Token → the one you just made.
3. Put the pair in the repo-root `.env`:

   ```bash
   CF_ACCESS_CLIENT_ID=<id>.access
   CF_ACCESS_CLIENT_SECRET=<secret>
   ```

4. Automated callers send them as headers:

   ```bash
   curl -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
        -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
        https://hq.<domain>/api/health
   ```

> This is the same class of bug as the hosted console's `X-Forwarded-Proto`
> requirement: a request that looks fine and silently is not authenticated.
> When something starts returning HTML where JSON is expected, check this first.

`hq-publisher` and `hq-intents` are unaffected — they talk outbound to Vercel and
never traverse this tunnel.

---

## What this does and does not fix

**Fixes:** the hostname stops changing; there is a second factor in front of a
surface that can approve high-risk builds; one tunnel now has room for every
other service this box will run.

**Does not fix:** anything about the origin. A named tunnel with a stopped
dashboard gives you a stable URL that 502s. Tunnel health is not service health —
`node scripts/hq-route-usage.mjs --errors` is where the origin's own problems show.
