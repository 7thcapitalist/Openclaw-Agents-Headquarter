# Research Agenda

Standing external-research topics for the Learning / R&D Agent. The agent works
through stale items (oldest `Last reviewed` first) when the founder or a cron job
runs `npm run factory:learn -- research --topic "<topic>"`.

Rules:
- Every research note must cite real, checkable sources.
- A note is a recommendation. It never creates an issue, task, branch, or PR.
- The founder promotes useful notes into `ENGINEERING_IMPROVEMENTS.md` or
  `PROCESS_IMPROVEMENTS.md`.

## Topics

| Topic | Why it matters | Last reviewed |
| --- | --- | --- |
| Agent-orchestration patterns (multi-agent hand-off, review independence) | Core to the factory design | never |
| Evaluation of LLM coding agents (benchmarks, acceptance-test-first workflows) | Improves our gates and QA | never |
| Prompt and role-definition practices for autonomous builders | Directly improves `factory/prompts/*` | never |
| Secure autonomous CI/CD and worktree isolation | Protects the `./run.sh` and merge boundaries | never |
| Small-team / solo-founder software delivery practices | Keeps attention compression realistic | never |
| Competitor and adjacent tooling (agent IDEs, factory frameworks) | Product strategy input | never |

Add rows as the founder's interests change. Keep it short — this is a queue, not
a knowledge base.
