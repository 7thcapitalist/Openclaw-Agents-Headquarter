#!/usr/bin/env bash
set -euo pipefail

ROOT="${AGENT_LAB_ROOT:-$HOME/agent-lab}"
PROJECT="${1:-}"
ID="${2:-}"

valid_slug() {
  [[ "$1" =~ ^[a-z0-9][a-z0-9-]*$ ]] && [[ "$1" != *"--"* ]]
}

if ! valid_slug "$PROJECT" || ! valid_slug "$ID"; then
  echo "Usage: $0 <project-key> <agent-id>" >&2
  echo "  Use lowercase letters, numbers, hyphens only (no .. or /)." >&2
  exit 1
fi

AGENT_DIR="$ROOT/agents/$PROJECT/$ID"
if [[ -d "$AGENT_DIR" ]]; then
  echo "Agent directory already exists: $AGENT_DIR" >&2
  exit 1
fi

mkdir -p "$AGENT_DIR"/{src,logs,outputs}
touch "$AGENT_DIR/agent.config.json"
touch "$AGENT_DIR/prompt.md"

TODAY=$(date +%Y-%m-%d)
cat > "$AGENT_DIR/agent.config.json" <<EOF
{
  "id": "$ID",
  "project": "$PROJECT",
  "name": "$ID",
  "description": "TODO: one-sentence purpose.",
  "status": "inactive",
  "type": "manual",
  "schedule": null,
  "entrypoint": "./run.sh",
  "workingDirectory": "~/agent-lab/agents/$PROJECT/$ID",
  "tools": [],
  "requiresApproval": [],
  "logsPath": "./logs/latest.log",
  "outputsPath": "./outputs",
  "createdAt": "$TODAY",
  "owner": "operator"
}
EOF

cat > "$AGENT_DIR/prompt.md" <<'EOF'
# Agent prompt

Define role, inputs, outputs, and safety rules here.
EOF

cat > "$AGENT_DIR/run.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "\${AGENT_LAB_ROOT:-\$HOME/agent-lab}/agents/$PROJECT/$ID"
mkdir -p logs outputs
echo "[$PROJECT/$ID] starting at \$(date -Iseconds)" >> logs/latest.log
# Wire your runner (OpenClaw, node, etc.) here.
echo "[$PROJECT/$ID] stub run complete at \$(date -Iseconds)" >> logs/latest.log
EOF
chmod +x "$AGENT_DIR/run.sh"

cat > "$AGENT_DIR/src/index.ts" <<'EOF'
// Optional TypeScript entry for compiled logic.
export {};
EOF

cat > "$AGENT_DIR/README.md" <<EOF
# $PROJECT / $ID

One-sentence purpose: **TODO**.

## Run locally

\`\`\`bash
cd ~/agent-lab/agents/$PROJECT/$ID
./run.sh
\`\`\`

## Register in dashboard DB

\`\`\`bash
cd ~/agent-lab
./scripts/register-agent.sh $PROJECT $ID
\`\`\`
EOF

touch "$AGENT_DIR/logs/.gitkeep" "$AGENT_DIR/outputs/.gitkeep"

echo "Created $AGENT_DIR"
echo "Next: edit agent.config.json and prompt.md, test ./run.sh, then ./scripts/register-agent.sh $PROJECT $ID"
