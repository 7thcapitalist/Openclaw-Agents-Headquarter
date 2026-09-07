# Mini PC Factory Server — Setup Log

This document records the setup of the dedicated Ubuntu mini PC that runs the OpenClaw software factory.

> **Security note:** private network addresses, tokens, credentials, and secrets are intentionally not committed to this public repository.

## Purpose

The mini PC is not intended to be the primary interactive development machine. It is an always-on private server that will run:

- OpenClaw and its Gateway
- autonomous coding agents
- Codex
- Claude Code
- Cursor CLI agents
- the OpenClaw Agents Headquarters dashboard
- project repositories and isolated agent workspaces
- scheduled/background jobs
- remote administration over Tailscale + SSH

The normal operator workflow is expected to happen from a notebook while the mini PC remains online and works in the background.

## Current Machine Foundation

### Operating system

- Fresh Ubuntu installation
- Linux host dedicated primarily to the autonomous-agent factory

### Base development tooling

Installed:

- `git`
- GitHub CLI (`gh`)
- `curl`
- `wget`
- `jq`
- `build-essential`
- OpenSSH client/server

### OpenClaw

Installed OpenClaw version at setup time:

```text
OpenClaw 2026.8.1
```

OpenClaw is configured with a local Gateway using systemd user services.

Gateway characteristics:

- systemd user service enabled
- local loopback binding
- default local port `18789`
- dashboard available locally through the Gateway
- Gateway restarts automatically through systemd

A startup problem was encountered because the Codex plugin existed in configuration but had not yet been installed with capability consent.

Resolution:

```bash
openclaw plugins install codex --accept-capabilities
openclaw gateway restart
openclaw gateway status
```

After the restart, expected healthy state was achieved:

```text
Runtime: running
Connectivity probe: ok
Listening: 127.0.0.1:18789
```

The OpenClaw agent/model setup successfully verified an OpenAI model during onboarding.

## Remote Access

### Tailscale

Tailscale was installed from the official Linux package source and authenticated to the operator's tailnet.

Installation flow:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Verification:

```bash
tailscale status
tailscale ip -4
```

The mini PC and the Windows notebook are registered on the same Tailscale account.

**Private Tailscale IPs are intentionally omitted from this repository.**

### SSH server

Installed:

```bash
sudo apt install -y openssh-server
sudo systemctl enable --now ssh
```

Verified with:

```bash
systemctl status ssh --no-pager
```

Remote SSH access from the Windows notebook over Tailscale was successfully validated. The notebook can now act as the operator cockpit while the mini PC remains headless.

Remote access uses the pattern:

```bash
ssh <ubuntu-user>@<tailscale-ip>
```

The initial SSH host key was accepted and stored in the notebook's known-hosts file.

### Wi-Fi stability hardening

The mini PC experienced intermittent Wi-Fi failures on the Realtek/rtw88 interface, including periods where the interface remained visible but could not maintain connectivity.

A driver/network stack reset was identified as a recovery procedure:

```bash
sudo modprobe -r rtw88_8821ce rtw88_8821c rtw88_pci rtw88_core
sudo modprobe rtw88_8821ce
sudo systemctl restart NetworkManager
```

For long-term stability, Wi-Fi power saving was disabled in NetworkManager:

```ini
[connection]
wifi.powersave = 2
```

Realtek/rtw88 PCIe and deep low-power behavior was also disabled:

```text
options rtw88_pci disable_aspm=Y
options rtw88_core disable_lps_deep=Y
```

The initramfs was updated after the driver settings were added.

Sleep/hibernate targets were masked so the machine behaves as an always-on server:

```bash
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
```

User lingering was enabled so user-level services can continue independently of a graphical login session:

```bash
sudo loginctl enable-linger joao-vitor
```

Tailscale and SSH were enabled to start automatically.

A full reboot test was completed successfully. After reboot, the machine returned to the tailnet automatically, accepted a fresh remote SSH connection, and the OpenClaw Gateway was already running without physical intervention.

Post-reboot verification:

```text
Tailscale: running
SSH: active (running)
OpenClaw Gateway: running
OpenClaw connectivity probe: ok
Wi-Fi power save: off
rtw88_pci disable_aspm: Y
rtw88_core disable_lps_deep: Y
```

This is the first successful headless-server reboot checkpoint.

## GitHub

GitHub CLI authentication was completed on the mini PC using device/browser login from the notebook. Git operations are configured to use HTTPS.

The HQ repository was cloned locally and the factory branch checked out:

```bash
cd ~
git clone https://github.com/7thcapitalist/Openclaw-Agents-Headquarter.git
cd Openclaw-Agents-Headquarter
git fetch origin
git switch factory-v1
```

Verified branch:

```text
factory-v1
```

## Coding Harnesses

### Codex CLI

Installed and authenticated successfully.

Version observed during setup:

```text
OpenAI Codex v0.151.0
```

### Claude Code

Installed globally with npm and authenticated successfully.

Version observed during setup:

```text
Claude Code 2.1.252
```

### Cursor CLI

Installed and authenticated successfully.

Version observed during setup:

```text
Cursor Agent v2026.08.25-3e8eec8
```

Cursor Origin CLI is intentionally not required for the current factory design because GitHub remains the durable source of truth and repository control plane.

## HQ Bootstrap

The HQ repository dependencies were installed successfully:

```bash
npm run setup
```

HQ demo state was seeded:

```bash
npm run seed:hq
```

The example research agent was registered:

```bash
npm run register:example
```

Factory readiness was checked with:

```bash
chmod +x scripts/factory-doctor.sh
./scripts/factory-doctor.sh
```

Doctor confirmed git, Node.js, npm, OpenClaw, GitHub CLI, Codex, Claude Code, and Cursor CLI are all present. The OpenClaw Gateway also remained healthy during the check.

The next orchestration checkpoint is ACP runtime diagnostics.

## Intended Architecture

```text
Windows notebook
    |
    | Tailscale private network
    v
Ubuntu mini PC
    |
    +-- SSH
    +-- OpenClaw Gateway
    +-- OpenClaw HQ dashboard
    +-- Codex
    +-- Claude Code
    +-- Cursor CLI
    +-- GitHub repositories
    +-- autonomous worker sessions
```

## Work Completed

- [x] Fresh Ubuntu installation
- [x] Base development packages installed
- [x] Git installed
- [x] GitHub CLI installed
- [x] Node/npm provisioned as part of OpenClaw setup
- [x] OpenClaw installed
- [x] OpenClaw model authentication verified
- [x] Codex OpenClaw plugin installed with capability consent
- [x] OpenClaw Gateway healthy
- [x] Tailscale installed and authenticated
- [x] OpenSSH server installed and enabled at boot
- [x] SSH from Windows notebook into mini PC validated
- [x] GitHub CLI authenticated on the mini PC
- [x] HQ repository cloned locally
- [x] `factory-v1` checked out
- [x] Codex CLI installed and authenticated
- [x] Claude Code installed and authenticated
- [x] Cursor CLI installed and authenticated
- [x] HQ dependencies installed
- [x] HQ demo state seeded
- [x] Example agent registered
- [x] Factory doctor executed
- [x] Wi-Fi power saving disabled
- [x] rtw88 PCIe ASPM disabled
- [x] rtw88 deep LPS disabled
- [x] Sleep/suspend/hibernate targets masked
- [x] User lingering enabled
- [x] Tailscale and SSH set to start automatically
- [x] Reboot validation passed: Tailscale returned automatically
- [x] Reboot validation passed: SSH returned automatically
- [x] Reboot validation passed: OpenClaw Gateway returned automatically
- [x] Post-reboot Wi-Fi driver settings verified active

## Next Steps

### Remote access hardening

- [x] Confirm Tailscale returns automatically after reboot
- [x] Confirm SSH works remotely after reboot
- [x] Confirm OpenClaw Gateway is running after reboot
- [ ] Optionally configure SSH keys so password entry is no longer required

### GitHub

- [ ] Configure Git identity if not already configured

### Coding harnesses

- [ ] Verify all three can operate non-interactively in controlled test workspaces

### OpenClaw orchestration

- [ ] Run ACP diagnostics
- [ ] Connect Codex/Claude/Cursor harnesses to OpenClaw
- [ ] Verify background agent session spawning

### HQ

- [x] Install HQ dependencies
- [x] Seed HQ state
- [x] Register example agent
- [x] Run `factory-doctor.sh`
- [ ] Keep HQ running as a persistent service
- [ ] Make HQ reachable privately through Tailscale

### Software Factory

- [ ] Dispatch a ready GitHub issue to an isolated agent workspace
- [ ] Add cross-model PR review
- [ ] Add independent QA gates
- [ ] Add founder Decision Cards
- [ ] Add founder dashboard / attention-compression view
- [ ] Prove the workflow on one real LifeMax feature

## Operating Principle

The desired end state is:

```text
Founder sets outcome
        ↓
Chief of Staff decomposes work
        ↓
Agents design / build / review / test
        ↓
Founder is interrupted only for strategic decisions
        ↓
Review final result
        ↓
Ship
```

The mini PC is the persistent execution environment; the notebook is the operator cockpit.

## Maintenance Commands

Useful checks:

```bash
# OpenClaw
openclaw status
openclaw gateway status

# Tailscale
tailscale status

# SSH
systemctl status ssh --no-pager

# Wi-Fi stability
iw dev wlp2s0 get power_save
cat /sys/module/rtw88_pci/parameters/disable_aspm
cat /sys/module/rtw88_core/parameters/disable_lps_deep

# GitHub
gh auth status

# coding harnesses
codex --version
claude --version
agent --version

# system health
uptime
df -h
free -h
```

Do not commit `.env` files, API keys, OAuth tokens, Tailscale auth keys, private network details, or contents of `~/.openclaw` containing secrets.

---

# Hosting Reliability Review — 2026-09-07

A review of whether the mini PC is a dependable always-on host for OpenClaw,
Headquarters, and long-running factory work, and whether an interactive SSH
session is a single point of failure. **It is not** — the persistence layer was
already built correctly. The fragility is the campus Wi-Fi, not SSH.

## Diagnosis of the "SSH keeps dropping" problem

`journalctl` shows a repeating pattern roughly every 20–40 minutes, ~50 times a
day:

```
wpa_supplicant: CTRL-EVENT-DISCONNECTED ... reason=3 locally_generated=1
NetworkManager: device (wlp2s0): state change: activated -> unavailable
kernel: wlp2s0: deauthenticating ... by local choice (Reason: 3=DEAUTH_LEAVING)
kernel: wlp2s0: <AP-A> rejected association temporarily; comeback duration ~5s
kernel: wlp2s0: disconnect from AP <AP-A> for new auth to <AP-B>
NetworkManager: ... disconnected -> prepare -> authenticating   (full 802.1X PEAP)
```

Findings:

- **The disconnects are client-initiated** (`locally_generated=1`,
  `DEAUTH_LEAVING`), not the AP kicking the machine off.
- The Wi-Fi is on **`eduroam`** — 802.1X PEAP enterprise auth with **multiple
  APs**. The RTL8821CE (`rtw88_8821ce`) roams between two campus APs and does a
  **full re-authentication + new DHCP lease** on each roam. The campus IP
  (`10.24.x.x`) is therefore unstable.
- Each re-auth kills every TCP connection bound to the Wi-Fi IP — **including the
  SSH session** — and pauses Tailscale for ~30 s. Anything running in the
  foreground of that SSH session dies with it.
- **SSH is a victim, not the cause.** It is simply the connection you always
  notice dying, because you are always SSH'd in when it happens.
- Tailscale **does** recover on its own after every one of these events (verified
  in `journalctl -u tailscaled`: `control: setPaused(true)` … `setPaused(false)`
  ~30 s later). The **Tailscale IP `100.113.73.59` is stable** even while the
  campus IP churns.

Prior driver mitigations (see the Wi-Fi section above) are still in place and
still correct: `rtw88_pci disable_aspm=Y`, `rtw88_core disable_lps_deep=Y`,
`wifi.powersave = 2`, MAC-randomization off, sleep targets masked, linger on.
They address the *driver-hang* failure mode; they do not stop *eduroam roam
churn*, which no client-side setting can fully fix.

**The only complete fix is wired Ethernet.** `enp1s0` exists and is cabled to
NetworkManager (`netplan-enp1s0`, autoconnect on); it is currently `DOWN` because
no cable is plugged in. Plugging in a cable eliminates 100 % of the churn. Until
then, always reach the machine over Tailscale (stable IP) and never run
long work in a bare SSH shell.

## What was already correct (left unchanged — no duplicate services created)

| Concern | Already in place |
|---|---|
| Wi-Fi auto-reconnect | `eduroam`: `autoconnect=yes`, `autoconnect-priority=200`, `autoconnect-retries=-1` (infinite). Fallback SSIDs saved with lower priorities. |
| Tailscale after reconnect/reboot | `tailscaled.service` — **system** service, `enabled`, `Restart` managed. Recovers from every Wi-Fi re-auth automatically. |
| OpenClaw gateway persistent | `openclaw-gateway.service` — **user** service, `enabled`, `Restart=always`, `After/Wants=network-online.target`. Binds `127.0.0.1:18789`. |
| Dashboard persistent | `pm2-hq.service` (user, `enabled`) runs `pm2 resurrect` → `hq-dashboard` (`127.0.0.1:3211`) + `hq-tunnel` (cloudflared). |
| Survives logout / SSH exit | `loginctl enable-linger joao-vitor` = **yes**. User services keep running with nobody logged in. |
| Long factory objectives survive SSH exit | Objectives started from the dashboard run **inside the `hq-dashboard` process** (a detached async task), which is under `pm2-hq.service`. No SSH dependency. |
| Logs after reconnecting | journald is **persistent** (`/var/log/journal`, boots -2/-1/0 retained). pm2 logs in `~/.pm2/logs/`. |
| Stable local dashboard port | Fixed at `127.0.0.1:3211`. |
| Reboot brings everything back | `tailscaled` + `ssh` (system, enabled) and `pm2-hq` + `openclaw-gateway` (user, enabled, `WantedBy=default.target`) + linger. Verified reboot checkpoint recorded earlier in this log. |

## Changes made in this review (small, reversible, non-root)

1. **`pm2 save`** — re-snapshotted the pm2 process list to
   `~/.pm2/dump.pm2` so a reboot resurrects exactly `hq-dashboard` + `hq-tunnel`
   (the dump on disk was from an earlier date).
2. **`~/.local/bin/hq`** — a founder operator helper (already on `$PATH`):
   - `hq alive` — one screen: services, ports, pm2 apps, Tailscale, dashboard
     HTTP, and a warning if Wi-Fi has flapped in the last hour.
   - `hq restart {dashboard|tunnel|pm2|gateway}` — restart one piece.
   - `hq logs {dashboard|tunnel|gateway|tailscale|wifi} [-f]` — tail logs.
   - `hq url` — where to reach everything.
3. **`~/.screenrc`** — sane defaults so closing an SSH window detaches a
   `screen` session instead of killing it (20k-line scrollback, autodetach,
   status line).

Nothing about the application, the services, or the network configuration was
changed.

## Recommended root changes (require `sudo` — run these once)

These are optional hardening. The system is already recoverable without them.

```bash
# 1. Reap dead SSH sessions and ride short Wi-Fi blips (server side)
sudo tee /etc/ssh/sshd_config.d/10-hq-keepalive.conf >/dev/null <<'CONF'
ClientAliveInterval 20
ClientAliveCountMax 6
TCPKeepAlive yes
CONF
sudo sshd -t && sudo systemctl reload ssh
# (undo: sudo rm /etc/ssh/sshd_config.d/10-hq-keepalive.conf && sudo systemctl reload ssh)

# 2. mosh — a shell that survives IP changes / roaming / long blips completely.
#    Best single fix for working over eduroam. No firewall change needed (ufw is inactive).
sudo apt update && sudo apt install -y mosh
#    then from Windows:  mosh joao-vitor@100.113.73.59

# 3. Remove the conflicting Wi-Fi power-save drop-in (two files disagree; keep the "=2" one)
sudo rm /etc/NetworkManager/conf.d/default-wifi-powersave-on.conf
sudo systemctl reload NetworkManager

# 4. Let the founder run tailscale without sudo, and (optional) enable Tailscale SSH
sudo tailscale set --operator=joao-vitor
sudo tailscale set --ssh                # optional: SSH in with tailnet identity, ACL-gated

# 5. Reach the dashboard over Tailscale with real TLS (needs HTTPS enabled for the
#    tailnet: admin console -> Settings -> Keys/HTTPS -> "Enable HTTPS"). Then:
sudo tailscale serve --bg 3211
#    -> https://joao-vitor-default-string.tail3eaee6.ts.net/   (private, no public exposure)
#    (undo: sudo tailscale serve --https=443 off)
```

If Ethernet gets plugged in and you want it preferred over Wi-Fi:

```bash
sudo nmcli connection modify netplan-enp1s0 connection.autoconnect-priority 300
```

## Is Tailscale the right way in? Yes.

Tailscale is already installed, authenticated (`7thcapitalist@github`), running as
a system service, and the Windows notebook is on the same tailnet
(`desktop-8cnj4uh`). It survives every Wi-Fi re-auth. **Use it; do not add another
remote-access system.** The cloudflared `hq-tunnel` is a *public* URL for the
dashboard only — keep it if you want the dashboard reachable without Tailscale,
otherwise `tailscale serve` (step 5) makes it private.

Node key expiry: **2027-02-28** — remote access keeps working until then. To make
it permanent, disable key expiry for this node in the Tailscale admin console.

---

# Founder Operating Procedure

Everything below is run **from the Windows notebook**. The mini PC needs no
keyboard, monitor, or logged-in user.

### 1. Access the mini PC remotely from Windows

```powershell
ssh joao-vitor@100.113.73.59
# or, once mosh is installed (recommended over flaky Wi-Fi):
mosh joao-vitor@100.113.73.59
```

Always use the **Tailscale IP `100.113.73.59`** (or the name
`joao-vitor-default-string`), never the campus `10.24.x.x` address — the campus
address changes and drops constantly; the Tailscale one does not.

Add to `C:\Users\<you>\.ssh\config` so the session tries to ride blips:

```
Host hq
    HostName 100.113.73.59
    User joao-vitor
    ServerAliveInterval 20
    ServerAliveCountMax 6
    TCPKeepAlive yes
```

Then just `ssh hq` / `mosh hq`.

### 2. Access OpenClaw

The gateway runs as a service on `127.0.0.1:18789`. From an SSH session on the
mini PC, the `openclaw` CLI talks to it automatically:

```bash
openclaw gateway status
openclaw agents list
openclaw cron list
```

You do not start or stop the gateway by hand — systemd keeps it up.

### 3. Access Headquarters (the dashboard)

- **Now:** the cloudflared tunnel URL (public, password-protected). Run
  `hq logs tunnel` on the mini PC to see the current URL, or check your
  Cloudflare Tunnels dashboard.
- **After `sudo tailscale serve --bg 3211`:** open
  `https://joao-vitor-default-string.tail3eaee6.ts.net/` from the Windows
  notebook while on Tailscale. Private, no public exposure.
- **Fallback (always works):** `ssh -L 3211:localhost:3211 hq` then open
  `http://localhost:3211` in the browser.

### 4. Check whether everything is alive

```bash
hq alive
```

One screen: tailscaled, openclaw-gateway, pm2-hq, sshd, both local ports, both
pm2 apps, Tailscale reachability, a dashboard HTTP probe, and a Wi-Fi-flapping
warning. Deeper check:

```bash
systemctl --user status openclaw-gateway.service pm2-hq.service
pm2 status
openclaw gateway status
cd ~/Openclaw-Agents-Headquarter && npm run hq:status
```

### 5. Restart something if necessary

```bash
hq restart dashboard     # just the HQ dashboard
hq restart tunnel        # just the public tunnel
hq restart gateway       # the OpenClaw gateway
hq restart pm2           # the whole pm2 layer (dashboard + tunnel)

# equivalents:
pm2 restart hq-dashboard
systemctl --user restart openclaw-gateway.service
systemctl --user restart pm2-hq.service
sudo systemctl restart tailscaled     # only if Tailscale itself is wedged
```

After a deliberate change to what pm2 runs: `pm2 save`.

### 6. Safely close your SSH window while agents keep working

Anything that is a **service** (gateway, dashboard, tunnel, Tailscale) and any
**objective started from the dashboard** already keeps running when you
disconnect — linger + systemd + pm2 guarantee it. You can just close the window.

For a command you run **by hand** in the shell (a CLI factory run, a build, a
long script), put it in `screen` first so it is not tied to the SSH session:

```bash
screen -S hq              # start (or: screen -r hq to re-attach later)
#   ... run your long command ...
# Ctrl-a then d  to detach — or just close the SSH window; it auto-detaches
screen -r hq              # after reconnecting, pick it back up
screen -ls                # list detached sessions
```

`mosh` (step 2 above) is even better: the same session simply reappears when the
network comes back, no detach/re-attach needed.

### Recovery cheatsheet

| Symptom | Do this |
|---|---|
| Can't SSH in at all | Wait 60 s (Wi-Fi re-auth) and retry. Still nothing after 5 min → it may need a physical power-cycle. |
| SSH connects, dashboard down | `hq restart dashboard`, then `hq logs dashboard` |
| Gateway probe failing | `hq restart gateway`, then `hq logs gateway` |
| Tailscale shows offline | `sudo systemctl restart tailscaled`; check `tailscale status` |
| Wi-Fi interface stuck (visible, no traffic) | `sudo systemctl restart NetworkManager`; if still dead: `sudo modprobe -r rtw88_8821ce && sudo modprobe rtw88_8821ce && sudo systemctl restart NetworkManager` |
| Everything wedged | `sudo reboot` — the full stack comes back on its own (verified). |
