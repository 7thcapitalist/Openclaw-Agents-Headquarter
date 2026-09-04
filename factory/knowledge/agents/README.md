# Agent Knowledge

One file per pipeline role. Holds durable, role-specific improvement notes the
Learning / R&D Agent has distilled from that role's track record — the "what this
employee should remember" layer.

Files: `product.md`, `architect.md`, `builder.md`, `reviewer.md`, `qa.md`,
`security.md`, `release.md`.

- Bullet points only. Each bullet is one actionable habit or check.
- Promoted by the founder, same as the global knowledge files.
- When Phase 3 handoff injection is enabled (`FACTORY_LEARNING_IN_HANDOFF=1` or
  `factory.config.json` → `learning.injectIntoHandoff: true`), the bullets here
  are appended to that role's handoff under a "Company knowledge" heading.
- These notes supplement `factory/prompts/<role>.md`; they never contradict it.
  A structural change to a role belongs in the prompt via a factory task.
