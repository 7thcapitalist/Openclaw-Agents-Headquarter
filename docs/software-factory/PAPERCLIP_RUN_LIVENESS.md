# Paperclip-Derived Run Liveness

The HQ liveness decision module adapts Paperclip's bounded continuation logic:

https://github.com/paperclipai/paperclip/blob/6abeb67334348dcb6fde2d591a27ffc7efc7118d/server/src/services/recovery/run-liveness-continuations.ts

Paperclip is MIT licensed, Copyright (c) 2025 Paperclip AI. HQ changes snake-case
states to its JavaScript naming convention and emits the narrow wakeup contract
planned in issue #82. Only `plan-only` and `empty-response` are automatically
continuable. Liveness never changes durable task state, and semantic continuation
attempts remain separate from process/factory recovery attempts.

Central provenance registration is required during pre-merge refresh after #79.
