# Search across the record

Adapted from Paperclip's `company-search` service and `Search.tsx` at pinned
commit `6abeb67334348dcb6fde2d591a27ffc7efc7118d` under MIT. See
`factory/third-party/provenance.json`. Issue #158.

## The gap

HQ had **no search endpoint at all** — verified against the full route list.
Finding "the task where the Vercel CLI pin was discussed" meant opening
objectives one at a time.

That mattered less when HQ held objectives and tasks. It matters now that it
also holds goals (#136), decision history (#142), run timelines (#148),
scorecards (#144) and interactions (#151). This campaign is what made the corpus
worth searching.

## The rule that shapes the whole design

**Search is a filter, never a reader.**

Every layer is an *existing projection* — the same function the corresponding
panel calls, with the same sanitisation. Nothing can appear in a result that
does not already appear in the panel the result came from, and every result
carries the endpoint the operator can open to see it in full.

A full-text index over the runtime tree would read prompts, agent prose and
arbitrary files. That is precisely what those projections exist to avoid, so it
is not what this does.

| Layer | Projection | What is searched |
| --- | --- | --- |
| `goals` | `buildGoalsSnapshot` | id, title, level, project, objective |
| `decisions` | `buildDecisionHistory` | kind, state, summary, question, correlation ids |
| `interactions` | `buildInteractionThread` | body (already secret-scrubbed), author, kind, mentions |
| `timeline` | `buildRunTimeline` | event kind, actor, stage, detail |
| `evidence` | task state | **paths only** |

The goal layer searches exactly the fields the goals *projection* carries — not
the fields of the registry file behind it. Searching a field the panel does not
project would be search reading something the operator cannot see.

## Evidence is paths only

An evidence artifact is a file in the repository. Its path is a reference the
operator can follow; its contents are none of HQ's business here. The path is
the result and the snippet — there is deliberately no content field, and a test
asserts there is none.

## The query is terms, never a pattern

A caller-supplied regular expression is two problems: a way to burn CPU on a
read-only endpoint, and a way to widen a match past what the caller can already
see. So the query is lowercased, stripped of control characters, split on
whitespace, deduped, and capped at 8 terms of 2–200 characters. **All** terms
must match — OR across five layers returns everything and finds nothing.

Nothing in the module builds a path from caller input. A traversal in the query
is just a term that matches nothing.

## Bounds

50 results by default, 200 maximum, 240-character snippets, 200 tasks scanned.
`total` reports what matched and `results` what was returned, with `truncated`
set — reporting only the second would make a partial answer look complete.

Measured against the live factory: **~50 ms across 20 tasks and all five
layers.**

## Degradation

A layer that cannot be read adds a warning and sets `available: false`; the
layers that do work still return results. An empty factory is an empty result,
not a failure. A rejected query is a **400 with the reason**, never a 500.

## The panel

`GET /api/hq/search?q=` plus a search box on the Today view. The panel renders
results and offers no action — a search box that can also change something is
one that will eventually change something by accident, and a test asserts it
contains no form control, button or handler.

Two things the panel says out loud, because an operator who cannot see them will
act on the panel's silence:

- its **scope** — that it searches the projections, and never prompts, agent
  output or file contents;
- that an interaction is **untrusted input**, exactly as its own panel says.

## The test that matters

`factory/test/hq-search.test.mjs` writes a canary string into `prompt.md`,
`handoff.md`, `result.json` and `factory/prompts/builder.md` in a fixture
factory — the files a real run actually leaves — then searches for the canary
and for each of those filenames, and asserts no result carries it and that the
canary matches nothing at all. A positive query in the same test proves the
fixture is genuinely searchable, so the canary test cannot pass by being empty.

## Rollback

Revert the PR. The route and panel disappear; no other behaviour changes,
because search never wrote anything.
