# First Week: Learn the Factory by Using It

Do not try to automate everything at once. The fastest way to learn this system is to ship one real, small feature through the whole loop.

## Day 1 — Make the mini PC ready

From the HQ repo on the mini PC:

```bash
./scripts/factory-doctor.sh
```

Then install/enable OpenClaw ACP if needed:

```bash
openclaw plugins install @openclaw/acpx
openclaw config set plugins.entries.acpx.enabled true
```

Run `/acp doctor` inside OpenClaw and authenticate the external coding CLIs you plan to use.

Verify these commands exist:

```bash
openclaw --version
codex --version
claude --version
agent --version
```

For Cursor CLI, `agent` is the command used by current Cursor CLI installations.

## Day 2 — Manual orchestration

Pick ONE small issue in a real project such as LifeMax.

1. Write the issue using `factory/templates/task.md`.
2. Ask the Chief of Staff to classify it Low/Medium/High risk.
3. Manually spawn the selected coding harness from OpenClaw.
4. Make the builder open a PR.
5. Send the PR to a different model for review.
6. Fix findings.
7. Run QA.
8. You merge.

The objective is not speed. Learn where context gets lost and where agents ask unnecessary questions.

## Day 3 — Standardize prompts

Tune the role prompts until:
- builders do not ask about trivial implementation choices,
- reviewers give specific findings,
- QA tests acceptance criteria rather than repeating code review,
- strategic questions arrive as Decision Cards.

## Day 4 — Automate dispatch

Build the dispatcher milestone: given a `status:ready` GitHub issue, the HQ should create an isolated workspace and start exactly one primary builder.

Do not auto-merge yet.

## Day 5 — Automate review

When a builder opens a PR:
- select a different review harness,
- run review,
- send findings back to builder,
- repeat until blocking findings are resolved or a strategic decision is needed.

## Day 6 — Add QA + evidence

For UI: screenshots/browser checks.
For backend: tests, failure cases, API contract checks.
For data migrations: dry-run and rollback evidence.

## Day 7 — Founder view

Add a dashboard view that only answers:
- What is building?
- What is in review?
- What is blocked?
- What shipped?
- What decisions need me?

If the system makes you watch agent logs all day, the factory is failing. The product is **attention compression**.

## First real experiment

Use LifeMax as the first customer of the factory. Choose a small, reviewable issue—not the full health integration. A good first test is an isolated onboarding or dashboard improvement.

After each run, record one thing the factory did well and one place where you had to intervene. Those interventions become the roadmap.