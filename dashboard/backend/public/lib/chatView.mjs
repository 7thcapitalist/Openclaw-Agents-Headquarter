// The conversation surface: a thread list, a transcript, and the work a reply
// proposes.
//
// Pure markup. Every control here is a `data-*` attribute that app.js binds,
// because this module renders untrusted text — an agent's reply — and a module
// that both renders model output and holds handlers is one editing mistake away
// from executing it.
//
// The one thing this panel must never do is make a proposal look like it has
// already happened. A proposal is a button. `renderProposal` therefore always
// shows the literal kind and arguments that will run, not a paraphrase: the
// founder is the authority here and he cannot authorize what he cannot read.

export function threadListPanel(source, { esc = escapeHtml, activeId = null } = {}) {
  const threads = Array.isArray(source?.threads) ? source.threads : [];
  const rows = threads.map((thread) => `
    <button type="button" class="chat-thread-row${thread.id === activeId ? " active" : ""}" data-thread="${esc(thread.id)}">
      <span class="chat-thread-title">${esc(thread.title)}</span>
      <span class="chat-thread-meta">${esc(thread.agentId)} · ${thread.turnCount} message${thread.turnCount === 1 ? "" : "s"}${
        thread.status === "running" ? " · thinking…" : thread.status === "failed" ? " · failed" : ""}</span>
    </button>`).join("");

  return `<aside class="chat-threads" aria-label="Conversations">
    <button type="button" class="btn primary chat-new" data-chat-new="1">New conversation</button>
    ${rows || `<p class="quiet-state">No conversations yet.</p>`}
  </aside>`;
}

export function transcriptPanel(thread, { esc = escapeHtml } = {}) {
  if (!thread) {
    return `<section class="chat-transcript"><div class="quiet-state">
      Pick a conversation, or start a new one.
    </div></section>`;
  }

  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const body = turns.length
    ? turns.map((turn) => renderTurn(turn, esc)).join("")
    : `<div class="quiet-state">Say something to ${esc(thread.agentId)} to begin.</div>`;

  const budget = `${thread.turnsToday}/${40} today`;

  return `<section class="chat-transcript" aria-label="Conversation">
    <header class="chat-header">
      <h2>${esc(thread.title)}</h2>
      <span class="chat-header-meta">${esc(thread.agentId)} · ${esc(budget)}
        <button type="button" class="btn ghost small" data-chat-delete="${esc(thread.id)}">Delete</button></span>
    </header>
    <div class="chat-log" id="chat-log">${body}</div>
    ${thread.status === "running" ? `<p class="chat-pending" role="status">Thinking… this takes up to 90 seconds.</p>` : ""}
    <form class="chat-composer" data-chat-send="${esc(thread.id)}">
      <textarea id="chat-input" rows="3" placeholder="Ask, or describe what you want built…"
        aria-label="Message"${thread.status === "running" ? " disabled" : ""}></textarea>
      <button type="submit" class="btn primary"${thread.status === "running" ? " disabled" : ""}>Send</button>
    </form>
  </section>`;
}

function renderTurn(turn, esc) {
  if (turn.error) {
    return `<div class="chat-turn chat-agent"><div class="chat-bubble chat-error">${esc(turn.error)}</div></div>`;
  }
  const proposals = (turn.proposals || []).map((p) => renderProposal(p, turn.id, esc)).join("");
  return `<div class="chat-turn chat-${turn.role === "agent" ? "agent" : "founder"}">
    <div class="chat-bubble">${paragraphs(turn.text, esc)}${turn.truncated ? `<p class="muted small">(truncated)</p>` : ""}</div>
    ${proposals}
  </div>`;
}

// A proposal, shown as the exact thing that will run.
function renderProposal(proposal, turnId, esc) {
  const args = Object.entries(proposal.args || {})
    .map(([key, value]) => `<li><code>${esc(key)}</code>: ${esc(String(value))}</li>`).join("");

  if (proposal.status === "rejected") {
    // A rejected proposal is shown, not hidden. The founder should be able to
    // see that his agent tried to name something the factory does not allow.
    return `<div class="chat-proposal rejected">
      <span class="objective-status status-warn">Not allowed</span>
      <p class="muted small">${esc(proposal.kind || "unnamed action")} — ${esc(proposal.reason || "rejected")}</p>
    </div>`;
  }

  if (proposal.status === "accepted" || proposal.status === "failed") {
    return `<div class="chat-proposal ${proposal.status}">
      <span class="objective-status ${proposal.status === "accepted" ? "status-good" : "status-warn"}">${
        proposal.status === "accepted" ? "Started" : "Failed"}</span>
      <p class="muted small">${esc(proposal.kind)} — ${esc(proposal.detail || "")}</p>
    </div>`;
  }

  return `<div class="chat-proposal">
    <div class="chat-proposal-head">
      <span class="eyebrow">Proposed action</span>
      <code>${esc(proposal.kind)}</code>
    </div>
    <ul class="chat-proposal-args">${args}</ul>
    <button type="button" class="btn primary small"
      data-accept="${esc(proposal.id)}" data-turn="${esc(turnId)}">Run this</button>
  </div>`;
}

function paragraphs(text, esc) {
  return String(text || "").split(/\n{2,}/).filter(Boolean)
    .map((block) => `<p>${esc(block).replace(/\n/g, "<br>")}</p>`).join("") || `<p class="muted">(empty)</p>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
