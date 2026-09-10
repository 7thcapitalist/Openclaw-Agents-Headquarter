# Paperclip-Derived Agent Organization Model

HQ extends its existing registry with concepts from Paperclip's agent/company
model at commit `6abeb67334348dcb6fde2d591a27ffc7efc7118d`
(MIT, Copyright 2025 Paperclip AI): reporting lines, capabilities, runtime adapter
references, availability, and budget policy.

Sources:

- https://github.com/paperclipai/paperclip/blob/6abeb67334348dcb6fde2d591a27ffc7efc7118d/packages/db/src/schema/agents.ts
- https://github.com/paperclipai/paperclip/blob/6abeb67334348dcb6fde2d591a27ffc7efc7118d/docs/start/what-is-paperclip.md

Reporting lines and capabilities are discovery/routing metadata only. They never
grant permissions. Adapter configuration accepts secret reference identifiers,
not secret values. Validation rejects duplicate agents, dangling managers,
cycles, malformed budgets, and unknown adapter fields.

Central provenance registration is required during pre-merge refresh after #79.
