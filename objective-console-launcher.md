# Objective — the launcher tells you nothing while it works

Paste the block below into "Start an outcome", project **OpenClaw HQ (factory)**.

Written 2026-09-15 after a real launch was lost to this. Evidence: eleven Chief of
Staff intake calls ran against the Lifemaxing objective between 11:38:22 and
11:39:34, every one returned `questions: []` and wrote a contract to
`dashboard/backend/data/factory/lifemaxing/intake/`, and no objective was ever
created — `control-plane.json` has not been written since 2026-09-09 01:42:44.
`saveFounderJob` runs at `server.mjs:562` before anything that can fail, so the
objective POST never reached the server. The gap is client-side, after the intake
response returned.

---

The launcher in the founder console gives no feedback while Chief of Staff intake is running, so a launch that is working looks exactly like one that is broken. This cost a real launch on 2026-09-15: eleven intake calls ran in seventy-two seconds, every one succeeded, and not one objective was created. Fix the launcher so the founder can tell the difference, and stop preview intake leaving permanent artifacts behind.

Five pieces.

(1) While the intake request is in flight, disable the submit button and replace the silence with a visible progress state reading "Chief of Staff is reading your request…". Intake is a live model call that takes fifteen to forty seconds; today the button stays enabled and nothing on screen changes, so the founder clicks again and each click starts a fresh chain. The button must re-enable on both success and failure, so a failed intake does not leave the form dead.

(2) Render the intake question inline in the launcher, below the outcome box, rather than in a modal. A modal can be dismissed by clicking outside it or pressing Escape, and when that happens the pending objective is discarded silently with no record anywhere. Inline, the question stays on screen until it is answered. Keep the same shape otherwise: one question, its options as buttons, and an "Other…" free-text path.

(3) Make failure visible. If the intake POST or the objective POST returns a non-2xx, or the fetch rejects, show the error in the launcher itself and not only as a toast that may already have faded. A launch that failed must never look the same as a launch that is still thinking.

(4) Honour `preview` in `createContractFromObjective` in `factory/lib/natural-language-intake.mjs`. The parameter is destructured on line 17 and never referenced again, so the preview intake behind `POST /api/founder/intake` writes a permanent contract to `<stateRoot>/intake/<id>.json` exactly as a real start does. When `preview` is true, return the contract and write no file. Then decide what to do with the eleven orphan contracts now sitting in `dashboard/backend/data/factory/lifemaxing/intake/`: they describe an objective that never launched and nothing will ever consume them.

(5) Add request logging to the dashboard. `dashboard/backend/server.mjs` logs no requests at all, so "did the POST arrive" can only be answered by reading file modification times. Log method, path, status and duration for every `/api/` request. Do not log request bodies: the objective text is founder content and must not be written to a log file.

Acceptance criteria. Clicking "Start an outcome" disables the button and shows the progress state immediately, demonstrated by a test. The button re-enables and the error text appears in the launcher when intake returns non-2xx. The intake question renders inline, with a test proving the pending objective survives both an Escape keypress and a click outside the launcher. A unit test proves `createContractFromObjective({ preview: true })` returns a contract and writes no file, and that the non-preview path still writes one. `pm2 logs hq-dashboard` shows one line per `/api/` request carrying method, path, status and duration, and no log line contains any of the objective text. The full factory suite passes via `npm run test:factory`.

Constraints. No change to auth, setup, migration or backup code. No change to the intake prompt or to how Chief of Staff classifies risk — this is the launcher and the preview flag, not intake behaviour. No new dependency for logging; use what the server already has. Do not change `HQ_AUTO_RETRY` and do not add any fixed-interval loop.
