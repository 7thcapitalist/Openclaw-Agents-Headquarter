#!/usr/bin/env bash
set -euo pipefail

cd "${AGENT_LAB_ROOT:-$(pwd)}/agents/example-project/research-analyst"
mkdir -p logs outputs

{
  echo "[example-project/research-analyst] started at $(date -Iseconds)"
  echo "[example-project/research-analyst] writing demo brief"
} >> logs/latest.log

cat > outputs/latest-brief.md <<'EOF'
# Demo Research Brief

This example worker shows the folder contract used by OpenClaw Startup HQ.

## Findings

- The dashboard registers worker agents from `agent.config.json`.
- Runs are executed through the local `run.sh` file.
- Logs and outputs stay inside the agent folder.

## Next Action

Replace this stub with an OpenClaw command, Node script, or automation flow.
EOF

echo '[{"title":"Demo Research Brief","path":"outputs/latest-brief.md"}]' > outputs/.agent-lab-artifacts.json
echo "[example-project/research-analyst] finished at $(date -Iseconds)" >> logs/latest.log
