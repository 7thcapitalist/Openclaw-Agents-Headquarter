#!/usr/bin/env bash
set -euo pipefail

ROOT="${AGENT_LAB_ROOT:-$HOME/agent-lab}"
PROJECT="${1:-}"
ID="${2:-}"

if [[ -z "$PROJECT" ]] || [[ -z "$ID" ]]; then
  echo "Usage: $0 <project-key> <agent-id>" >&2
  exit 1
fi

CONFIG="$ROOT/agents/$PROJECT/$ID/agent.config.json"
if [[ ! -f "$CONFIG" ]]; then
  echo "Missing $CONFIG" >&2
  exit 1
fi

BACKEND="$ROOT/dashboard/backend"
if [[ ! -d "$BACKEND" ]]; then
  echo "Missing dashboard backend at $BACKEND" >&2
  exit 1
fi

cd "$BACKEND"
if [[ ! -d node_modules ]]; then
  npm install --silent
fi

node lib/register-agent-cli.mjs "$ROOT" "$PROJECT" "$ID"
echo "Registered $PROJECT/$ID in dashboard database."
