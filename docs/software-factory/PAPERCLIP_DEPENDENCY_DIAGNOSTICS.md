# Dependency diagnostics and wakeups

The objective graph can now produce read-only health findings for invalid
graphs, blocked subtrees, stale running nodes, and objectives with no runnable
work. A pure transition helper produces identifier-only, deterministic wakeup
requests when a dependency change makes a node runnable. Queue persistence and
execution continue through the existing wakeup and lease boundaries.

The behavior is inspired by Paperclip's dependency-wakeup and graph-liveness
services at pinned commit `6abeb67334348dcb6fde2d591a27ffc7efc7118d`.
