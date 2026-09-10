// The founder's thread on a task.
//
// Everything rendered here is untrusted input, so it is escaped without
// exception and never rendered as markup, a link, or anything clickable. The
// panel also says out loud what a comment can and cannot do — a founder who
// believes a comment instructs an agent will write instructions into it.

const KIND_LABEL = { comment: "comment", question: "question", note: "note" };

export function interactionsSection(thread, { esc = escapeHtml, fmtTime = (value) => value || "—", canPost = true } = {}) {
  if (!thread) {
    return section(`<p class="quiet-state">Comments are not available for this run.</p>`, canPost);
  }
  if (thread.available === false) {
    return section(`<p class="operations-warning" role="status">The comment thread could not be read: ${esc(thread.reason || "unknown error")}</p>`, canPost);
  }

  const interactions = Array.isArray(thread.interactions) ? thread.interactions : [];
  const body = `
    ${thread.truncated ? `<p class="timeline-note">Showing the ${interactions.length} most recent of ${number(thread.total)}.</p>` : ""}
    ${number(thread.redactedCount) ? `<p class="timeline-note">${number(thread.redactedCount)} comment(s) had secret-shaped text removed before storage.</p>` : ""}
    <div class="interaction-stream">${interactions.slice().reverse().map((item) => renderInteraction(item, esc, fmtTime)).join("")
      || `<div class="quiet-state">No comments on this run yet.</div>`}</div>
  `;
  return section(body, canPost);
}

function renderInteraction(item, esc, fmtTime) {
  const mentions = Array.isArray(item.mentions) ? item.mentions : [];
  return `<div class="interaction">
    <div class="interaction-head">
      <strong>${esc(item.author?.id || "unknown")}</strong>
      <span>${esc(KIND_LABEL[item.kind] || "comment")} · ${esc(fmtTime(item.occurredAt))}</span>
    </div>
    <p>${esc(item.body)}</p>
    ${mentions.length ? `<p class="interaction-mentions">mentions ${mentions.map((mention) => esc(mention)).join(", ")}</p>` : ""}
    ${(item.redactions || []).length ? `<p class="interaction-mentions">redacted: ${(item.redactions || []).map((name) => esc(name)).join(", ")}</p>` : ""}
  </div>`;
}

function section(body, canPost) {
  return `<section class="run-interactions" aria-labelledby="run-interactions-title">
    <div class="operation-section-title"><span class="eyebrow">Thread</span><h3 id="run-interactions-title">Comments</h3></div>
    ${body}
    ${canPost ? `<form class="interaction-form" data-interaction-form><label class="sr-only" for="interaction-body">Add a comment</label><textarea id="interaction-body" name="body" rows="2" maxlength="4000" placeholder="Add a note for the record. Mention an agent with @name to wake it."></textarea><button class="btn secondary" type="submit">Post comment</button></form>` : ""}
    <p class="interaction-note">A comment is a record, not an instruction. Mentioning an agent wakes it; the text itself is never given to an agent as a command.</p>
  </section>`;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
