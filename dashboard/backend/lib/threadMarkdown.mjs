// Formatting the Chief of Staff's replies.
//
// He writes Markdown — headings, bold, lists — and the chat showed it as raw
// `**` and `###`. The reply is model output, the least trusted text in this
// system, so it is rendered by `renderUntrustedMarkdown` and nothing else: the
// two-layer renderer built for agent reports under FCT-P0-04. A second renderer
// written for chat would be a second thing to get wrong.
//
// Only AGENT turns are rendered. The founder's own messages stay escaped text:
// formatting them would make his words mean something other than what he typed,
// and there is no reason to widen the rendered surface to text we already show
// correctly.
//
// Rendered here, on the server, because that is where the renderer and its
// sanitizer live — the page receives HTML that has already passed both layers,
// exactly as the completion-report and objective-report routes do.

import { renderUntrustedMarkdown } from "./safeMarkdown.mjs";

export function withRenderedReplies(panel, render = renderUntrustedMarkdown) {
  if (!panel || !Array.isArray(panel.threads)) return panel;
  return {
    ...panel,
    threads: panel.threads.map((thread) => (!Array.isArray(thread.turns) ? thread : {
      ...thread,
      turns: thread.turns.map((turn) => (
        turn.role === "agent" && !turn.error && turn.text
          ? { ...turn, html: render(turn.text) }
          : turn
      )),
    })),
  };
}
