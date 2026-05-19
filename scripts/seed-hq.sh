#!/usr/bin/env bash
set -euo pipefail

ROOT="${AGENT_LAB_ROOT:-$(pwd)}"
SRC="$ROOT/examples/hq"
DST="$ROOT/dashboard/backend/data/hq"

if [[ ! -d "$SRC" ]]; then
  echo "Missing examples at $SRC" >&2
  exit 1
fi

mkdir -p "$DST/projects"
cp "$SRC"/agents.json "$DST"/agents.json
cp "$SRC"/tasks.json "$DST"/tasks.json
cp "$SRC"/reports.json "$DST"/reports.json
cp "$SRC"/sops.json "$DST"/sops.json
cp "$SRC"/logs.json "$DST"/logs.json
cp "$SRC"/projects/*.json "$DST"/projects/

echo "Seeded HQ demo data into $DST"
