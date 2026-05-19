#!/usr/bin/env bash
set -euo pipefail

PROJECT="${1:-}"
ID="${2:-}"

if [[ -z "$PROJECT" ]] || [[ -z "$ID" ]]; then
  echo "Usage: $0 <project-key> <agent-id>" >&2
  exit 1
fi

PM2_NAME="${PROJECT}-${ID}"

if command -v pm2 >/dev/null 2>&1; then
  pm2 restart "$PM2_NAME" || {
    echo "PM2 restart failed; try ./scripts/start-agent.sh $PROJECT $ID" >&2
    exit 1
  }
  echo "PM2: restarted $PM2_NAME"
else
  echo "pm2 not found" >&2
  exit 1
fi
