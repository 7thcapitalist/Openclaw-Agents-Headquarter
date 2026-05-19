#!/usr/bin/env bash
set -euo pipefail

ROOT="${AGENT_LAB_ROOT:-$HOME/agent-lab}"
PROJECT="${1:-}"
ID="${2:-}"

if [[ -z "$PROJECT" ]] || [[ -z "$ID" ]]; then
  echo "Usage: $0 <project-key> <agent-id>" >&2
  exit 1
fi

AGENT_DIR="$ROOT/agents/$PROJECT/$ID"
RUN="$AGENT_DIR/run.sh"

if [[ ! -x "$RUN" ]]; then
  echo "Missing or non-executable $RUN" >&2
  exit 1
fi

PM2_NAME="${PROJECT}-${ID}"

if command -v pm2 >/dev/null 2>&1; then
  if pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
    pm2 restart "$PM2_NAME"
  else
    pm2 start "$RUN" --name "$PM2_NAME" --cwd "$AGENT_DIR" --interpreter bash
  fi
  echo "PM2: $PM2_NAME started"
else
  echo "pm2 not found" >&2
  exit 1
fi
