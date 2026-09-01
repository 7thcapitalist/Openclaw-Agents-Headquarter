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
