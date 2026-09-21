# Idle self-improvement trigger

The `hq-idle-trigger` process turns an evidence-backed learning finding into a
normal `openclaw-factory` objective only when the factory is idle and provider
credit would otherwise expire. The objective uses the existing intake,
seven-stage workflow, gates, PR publication, and founder merge authority.

Configuration lives at `learning.idleTrigger` in `factory/factory.config.json`.
`mode` is `off`, `shadow`, or `on` and defaults to `on` when absent. Shadow mode
records launch decisions without filing work. The worker is additionally bounded
to four launches per UTC day and fewer than three open learning PRs.

Founder work always wins. A learning objective already in flight finishes its
current node, then yields before another node or integration starts. It resumes
after founder work clears. High-risk findings are recorded as founder proposals
whose evidence links point only into canonical factory state.

The read-only `GET /api/hq/idle-trigger` surface exposes the current reason,
launch/shadow/proposal history, estimated credit accounting, and findings with
their canonical evidence links.
