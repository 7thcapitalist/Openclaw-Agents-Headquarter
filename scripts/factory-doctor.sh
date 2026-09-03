#!/usr/bin/env bash
set -euo pipefail

printf '\nOpenClaw Software Factory Doctor\n'
printf '================================\n\n'

fail=0
check_required() {
  local cmd="$1"
  if command -v "$cmd" >/dev/null 2>&1; then
    printf '✓ %-10s %s\n' "$cmd" "$(command -v "$cmd")"
  else
    printf '✗ %-10s missing (required)\n' "$cmd"
    fail=1
  fi
}

check_optional() {
  local cmd="$1"
  local label="$2"
  if command -v "$cmd" >/dev/null 2>&1; then
    printf '✓ %-10s %s\n' "$label" "$(command -v "$cmd")"
  else
    printf '! %-10s not found yet\n' "$label"
  fi
}

check_required git
check_required node
check_required npm
check_required openclaw
check_optional gh GitHub
check_optional codex Codex
check_optional claude Claude
check_optional agent Cursor

printf '\nOpenClaw\n--------\n'
if command -v openclaw >/dev/null 2>&1; then
  openclaw --version 2>/dev/null || true
  printf '\nGateway status:\n'
  openclaw gateway status 2>/dev/null || printf '! Gateway status unavailable. Start/configure OpenClaw before autonomous dispatch.\n'
  printf '\nACP plugin check:\n'
  if openclaw plugins list 2>/dev/null | grep -qi 'acpx'; then
    printf '✓ acpx appears in installed plugins\n'
  else
    printf '! acpx not detected. Install with:\n'
    printf '  openclaw plugins install @openclaw/acpx\n'
    printf '  openclaw config set plugins.entries.acpx.enabled true\n'
  fi
fi

printf '\nGit\n---\n'
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  printf '✓ running inside a Git repository\n'
  printf '  branch: %s\n' "$(git branch --show-current 2>/dev/null || true)"
else
  printf '! run this doctor from the HQ repository on the mini PC\n'
fi

printf '\nNext checks\n-----------\n'
printf '1. Open OpenClaw and run /acp doctor.\n'
printf '2. Confirm Codex, Claude Code, and Cursor CLI are authenticated on this host.\n'
printf '3. Read docs/software-factory/FIRST_WEEK.md.\n'
printf '4. Do not enable autonomous merge/deploy yet.\n\n'

if [[ "$fail" -ne 0 ]]; then
  exit 1
fi