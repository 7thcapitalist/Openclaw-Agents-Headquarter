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
  pm2 stop "$PM2_NAME" 2>/dev/null || echo "PM2: $PM2_NAME was not running"
else
  echo "pm2 not found" >&2
  exit 1
fi
