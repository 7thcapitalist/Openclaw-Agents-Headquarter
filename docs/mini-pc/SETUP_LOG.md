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

Expected state:

```text
Active: active (running)
```

The Linux account used for administration is the normal non-root user.

Once the notebook is online on the same Tailscale network, remote access should use the pattern:

```bash
ssh <ubuntu-user>@<tailscale-ip>
```

This allows the physical keyboard/monitor on the mini PC to become unnecessary for routine operation.

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
- [x] Tailscale installed
- [x] Mini PC authenticated to Tailscale
- [x] Windows notebook registered in the same tailnet
- [x] OpenSSH server installed
- [x] SSH service enabled at boot
- [x] SSH server verified active

## Next Steps

### Remote access validation

- [ ] Bring Windows notebook online in Tailscale
- [ ] SSH from notebook into mini PC
- [ ] Optionally configure SSH keys so password entry is no longer required
- [ ] Confirm remote access still works after mini PC reboot

### GitHub

- [ ] Authenticate GitHub CLI on the mini PC
- [ ] Configure Git identity
- [ ] Clone `Openclaw-Agents-Headquarter` locally
- [ ] Switch to the `factory-v1` branch

### Coding harnesses

- [ ] Install and authenticate Codex CLI
- [ ] Install and authenticate Claude Code
- [ ] Install and authenticate Cursor CLI
- [ ] Verify all three can operate non-interactively

### OpenClaw orchestration

- [ ] Install/enable ACP runtime
- [ ] Run ACP diagnostics
- [ ] Connect Codex/Claude/Cursor harnesses to OpenClaw
- [ ] Verify background agent session spawning

### HQ

- [ ] Install HQ dependencies
- [ ] Seed HQ state
- [ ] Run `factory-doctor.sh`
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

# GitHub
gh auth status

# system health
uptime
df -h
free -h
```

Do not commit `.env` files, API keys, OAuth tokens, Tailscale auth keys, private network details, or contents of `~/.openclaw` containing secrets.
