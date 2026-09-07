# Scheduled learning cycle

`factory-learn.timer` runs `npm run factory:learn -- cycle` every 3 days — the
retrospective + mastery pass defined in `DECISIONS.md` SFD-2026-008.

## Install (user scope, matches `openclaw-gateway.service`)

```sh
mkdir -p ~/.config/systemd/user
cp factory/ops/systemd/factory-learn.service ~/.config/systemd/user/
cp factory/ops/systemd/factory-learn.timer   ~/.config/systemd/user/
# Edit WorkingDirectory in the .service if the repo is not at ~/Openclaw-Agents-Headquarter
systemctl --user daemon-reload
systemctl --user enable --now factory-learn.timer
systemctl --user list-timers factory-learn.timer      # confirm next run
```

## Run one cycle by hand

```sh
npm run factory:learn -- cycle
# or scope it: --lookbackDays 14 --researchCalls 3
```

## Turn autonomy off (stay proposal-only)

Set `learning.autonomy.enabled: false` in `factory/factory.config.json`. The
timer still runs and still files findings + the mastery digest; it just stops
opening auto-merge-candidate PRs. To stop the schedule entirely:
`systemctl --user disable --now factory-learn.timer`.

## What one cycle writes

- `dashboard/backend/data/factory/_learning/digest.md` — founder digest (now includes factory performance metrics)
- `.../metrics.json` — latest performance snapshot (used for the next run's trend)
- `.../mastery-state.json` — rotation cursor + history
- `.../autonomy-log.jsonl` — one line per cycle: what ran, what was proposed, what was auto-opened
- `.../runs/<ts>.json` — full run record
- `factory/knowledge/agents/<role>.md` — a dated mastery-log entry for the cycle's deep-dive role
- when `learning.autonomy.enabled` and there are whitelisted proposals: one `learning/<date>-mastery-cycle` branch + PR
