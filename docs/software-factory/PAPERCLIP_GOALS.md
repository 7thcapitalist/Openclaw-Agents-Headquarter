# Paperclip-derived goal hierarchy

HQ supports a three-level company → project → objective goal projection. Goal
definitions provide stable intent and hierarchy; their status and percentage
are always calculated from canonical objective/task state. Agents cannot mark a
goal complete independently of delivery evidence.

The validator rejects duplicate identifiers, missing parents, invalid level
ordering, cycles, and cross-project children. Missing canonical work appears as
`unavailable`, not false progress. This foundation is read-only; persistence
and dashboard presentation follow through normal scoped PRs.

The hierarchy is adapted from Paperclip's `goals` service at pinned commit
`6abeb67334348dcb6fde2d591a27ffc7efc7118d` under MIT, with HQ-specific
authority and progress rules.
