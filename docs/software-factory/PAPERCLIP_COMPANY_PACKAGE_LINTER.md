# Paperclip Agent Companies Package Linter

The read-only linter implements the relevant portable conventions from
Paperclip's Agent Companies draft at commit
`6abeb67334348dcb6fde2d591a27ffc7efc7118d` (MIT, Copyright 2025 Paperclip AI):

https://github.com/paperclipai/paperclip/blob/6abeb67334348dcb6fde2d591a27ffc7efc7118d/docs/companies/companies-spec.md

It discovers `COMPANY.md`, `TEAM.md`, `AGENTS.md`, `PROJECT.md`, `TASK.md`, and
`SKILL.md`; validates a deliberately small YAML-frontmatter subset; requires
immutable external GitHub refs; and rejects path traversal, secret-shaped files,
and secret-shaped content. It performs no network access and writes nothing.

Run `node scripts/lint-agent-company.mjs /path/to/package`. Central provenance
registration is required during pre-merge refresh after #79.
