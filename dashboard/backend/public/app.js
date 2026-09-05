(function () {
  const app = document.getElementById("app");
  const nav = document.getElementById("nav");
  const toastEl = document.getElementById("toast");
  const modal = document.getElementById("modal");
  const modalTitle = document.getElementById("modal-title");
  const modalBody = document.getElementById("modal-body");

  const BOARD_COLUMNS = ["Inbox", "Assigned", "In Progress", "Review", "Done", "Blocked"];
  const SEVERITY_RANK = { high: 0, medium: 1, low: 2, unspecified: 3 };

  function showToast(msg, err) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    toastEl.style.borderColor = err ? "var(--red)" : "var(--border)";
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => {
      toastEl.hidden = true;
    }, 4200);
  }

  function openModal(title, html) {
    modalTitle.textContent = title;
    modalBody.innerHTML = html;
    modal.hidden = false;
  }

  function closeModal() {
    modal.hidden = true;
  }

  document.getElementById("modal-x").onclick = closeModal;
  modal.querySelector(".modal-backdrop").onclick = closeModal;

  document.getElementById("btn-logout").onclick = async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    location.href = "/login.html";
  };

  async function api(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (opts.body && typeof opts.body === "string" && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    const res = await fetch(path, { credentials: "include", ...opts, headers });
    if (res.status === 401) {
      location.href = "/login.html";
      throw new Error("Unauthorized");
    }
    return res;
  }

  async function apiJson(path, opts = {}) {
    const res = await api(path, opts);
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Server returned non-JSON (${res.status})`);
    }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmtTime(iso) {
    if (!iso) return "-";
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return String(iso);
    }
  }

  function byId(list) {
    return Object.fromEntries((Array.isArray(list) ? list : []).map((x) => [x.id, x]));
  }

  function projectName(projects, id) {
    return byId(projects)[id]?.name || id || "Global HQ";
  }

  function agentName(agents, id) {
    if (id === "operator") return "Operator";
    return byId(agents)[id]?.name || id || "-";
  }

  function riskSeverityOrder(a, b) {
    return (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3);
  }

  function parseRoute() {
    const raw = (location.hash || "#/today").replace(/^#\/?/, "");
    const segs = raw.split("/").filter(Boolean);
    if (!segs.length || segs[0] === "today" || segs[0] === "home") return { name: "today" };
    if (["agents", "projects", "tasks", "sops", "logs", "reports", "runs"].includes(segs[0])) return { name: segs[0] };
    if (segs[0] === "project" && segs[1]) return { name: "project", id: segs[1] };
    if (segs[0] === "agent" && segs[1] && segs[2]) return { name: "agent", project: segs[1], id: segs[2], tab: segs[3] || "overview" };
    if (segs[0] === "run" && segs[1]) return { name: "run", id: Number(segs[1]) };
    return { name: "today" };
  }

  function buildNav() {
    const items = [
      ["#/today", "today", "Today"],
      ["#/agents", "agents", "Agents"],
      ["#/projects", "projects", "Projects"],
      ["#/tasks", "tasks", "Task Board"],
      ["#/sops", "sops", "SOPs"],
      ["#/logs", "logs", "Logs"],
      ["#/reports", "reports", "Reports"],
      ["#/runs", "runs", "Runs"],
    ];
    nav.innerHTML = items.map(([href, id, label]) => `<a href="${href}" data-nav="${id}">${esc(label)}</a>`).join("");
    nav.querySelectorAll("a").forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        location.hash = a.getAttribute("href").slice(1);
      });
    });
  }

  function setNavActive(route) {
    const map = route.name === "project" ? "projects" : route.name === "agent" ? "agents" : route.name === "run" ? "runs" : route.name;
    nav.querySelectorAll("a").forEach((a) => a.classList.toggle("active", a.dataset.nav === map));
  }

  // ── Real data sources ──────────────────────────────────────────
  // The Headquarters Integration Layer's single "state of the company"
  // object. This — not the seed HQ store below — is the source of truth for
  // real projects, real organizational roles, real GitHub awareness, and real
  // OpenClaw runtime liveness.
  function loadCompany() {
    return apiJson("/api/hq/company?github=1&runtime=1");
  }

  function loadLearning() {
    return apiJson("/api/hq/learning");
  }

  // The older seed HQ store (dashboard/backend/data/hq/*.json). Still used by
  // the Task Board / SOPs / Reports pages below, which have no real backing
  // system yet — those pages are clearly labelled as example data, never
  // presented as the founder's real company.
  async function loadHq() {
    return apiJson("/api/hq");
  }

  function pill(text, kind) {
    return `<span class="badge ${kind || "badge-type"}">${esc(text)}</span>`;
  }

  function demoBanner(label) {
    return `<div class="demo-banner">${esc(
      label || "Example data — not the real company. See Today / Projects / Agents for the real Headquarters Integration Layer data."
    )}</div>`;
  }

  function taskCard(t, projects, agents) {
    return `
      <article class="task-card priority-${esc(String(t.priority || "low").toLowerCase())}">
        <div class="task-title">${esc(t.title)}</div>
        <div class="task-meta">${esc(projectName(projects, t.projectId))} · ${esc(agentName(agents, t.assignedAgent))}</div>
        <div class="task-detail">${esc(t.expectedOutput || "")}</div>
        <div class="task-footer">
          ${pill(t.priority || "Low", "badge-priority")}
          ${t.approvalRequired ? pill("Approval", "badge-warn") : ""}
          ${t.dueDate ? `<span class="muted small">${esc(t.dueDate)}</span>` : ""}
        </div>
      </article>`;
  }

  // ── Today: the founder observability surface ───────────────────

  async function renderToday() {
    const [state, fc, learning] = await Promise.all([
      loadCompany(),
      apiJson("/api/founder/overview").catch(() => ({ jobs: [] })),
      loadLearning().catch(() => null),
    ]);
    const projects = state.projects || [];
    const agents = state.agents?.agents || [];
    const decisions = state.decisions || [];
    const jobs = fc.jobs || [];

    app.innerHTML = `
      <section class="hq-layout">
        ${renderAgentRail(agents, state.runtime)}
        <main class="hq-main">
          <div class="founder-hero">
            <div class="eyebrow">${esc(state.founder?.headquarters || "Headquarters")}</div>
            <h1>What should the company build next?</h1>
            <p>Give your team an outcome. OpenClaw will turn it into bounded work and route the right agents.</p>
            <form id="founder-command" class="founder-command">
              <textarea id="founder-objective" rows="2" placeholder="Build Fitbit integration for LifeMaxing" required></textarea>
              <div class="founder-command-row">
                <select id="founder-project" required>
                  <option value="">Choose project</option>
                  ${projects.map((p) => `<option value="${esc(p.key)}" data-repo="${esc(p.repo || "")}">${esc(p.name)}</option>`).join("")}
                  ${state.headquarters ? `<option value="${esc(state.headquarters.key)}" data-repo="${esc(state.headquarters.repo || "")}">${esc(state.headquarters.name)} (infrastructure)</option>` : ""}
                </select>
                <input id="founder-repo" placeholder="Repository path" required />
                <button class="btn founder-launch" type="submit">Start work →</button>
              </div>
            </form>
          </div>

          ${runtimeBanner(state.runtime)}

          <div class="control-stats">
            <div><strong>${projects.length}</strong><span>Projects</span></div>
            <div><strong>${state.summary.workingAgents}</strong><span>Agents working</span></div>
            <div class="${decisions.length ? "attention" : ""}"><strong>${decisions.length}</strong><span>Need your input</span></div>
            <div><strong>${state.summary.openPullRequests}</strong><span>Open pull requests</span></div>
          </div>

          <section class="hq-infra-card">
            <div class="panel-heading">
              <div><span class="eyebrow">Infrastructure</span><h2>${esc(state.headquarters?.name || "OpenClaw Agents Headquarters")}</h2></div>
              ${pill("Headquarters — not a project", "badge-type")}
            </div>
            <p class="muted small">${esc(state.headquarters?.mission || "")}</p>
            <div class="project-facts">
              <span><small>Status</small><strong>${esc(state.headquarters?.status || "—")}</strong></span>
              <span><small>Active tasks</small><strong>${state.headquarters?.activeTasks?.length || 0}</strong></span>
              <span><small>GitHub</small><strong>${esc(state.headquarters?.externalSummary || (state.headquarters?.github ? "Configured" : "Not configured"))}</strong></span>
              <span><small>Context</small><strong>${state.headquarters?.hasContext ? "Present" : "Incomplete"}</strong></span>
            </div>
          </section>

          <div class="founder-grid">
            <section class="portfolio-panel">
              <div class="panel-heading"><div><span class="eyebrow">Portfolio</span><h2>Projects</h2></div></div>
              <div class="project-control-list">
                ${projects.map((p) => projectControlRow(p)).join("") || `<div class="empty-state">No projects registered in factory/projects.json yet.</div>`}
              </div>
            </section>
            <section class="inbox-panel">
              <div class="panel-heading"><div><span class="eyebrow">Founder inbox</span><h2>Decisions</h2></div>${decisions.length ? pill(decisions.length, "badge-warn") : pill("Clear", "health-healthy")}</div>
              ${decisions.map((x) => decisionCard(x)).join("") || `<div class="empty-state"><strong>Nothing needs you.</strong><span>Your agents have what they need to keep moving.</span></div>`}
              ${recommendedActions(state.company)}
            </section>
          </div>

          <section class="activity-panel">
            <div class="panel-heading"><div><span class="eyebrow">Live company</span><h2>Agent activity</h2></div><button class="btn secondary" id="ask-agent">Ask an agent</button></div>
            <div class="company-feed">
              ${jobs.filter((job) => job.status === "starting" || job.status === "error").slice(0, 5).map((job) => `<div class="company-agent"><span class="activity-pulse ${job.status === "error" ? "pulse-error" : ""}"></span><div><strong>${esc(job.projectId)}</strong><span>${esc(job.objective)}</span></div><em class="${job.status === "error" ? "danger-text" : ""}">${esc(job.status)}</em></div>`).join("")}
              ${agents.filter((a) => a.status === "working").map((a) => `<div class="company-agent"><span class="activity-pulse"></span><div><strong>${esc(a.name)}</strong><span>${esc(stageVerb(a.currentTask?.stage))} ${esc(a.currentTask?.objective || "")}</span></div><em>${esc(a.status)}</em></div>`).join("")}
              ${(state.activityFeed || []).slice(0, 8).map((e) => `<div class="company-event"><span>${esc(String(e.type || "event").replaceAll("-", " "))}</span><strong>${esc(e.taskId)}</strong><time>${esc(fmtTime(e.at))}</time></div>`).join("") || `<div class="empty-state">No active factory tasks. No factory task has run in this environment yet.</div>`}
            </div>
          </section>

          ${learningPanel(learning)}
          ${blindSpotsPanel(state)}
        </main>
      </section>`;
    bindFounderControls();
  }

  function runtimeBanner(runtime) {
    if (!runtime) {
      return `<div class="gap-banner">OpenClaw runtime status unavailable — runtime awareness is disabled in factory/hq.config.json.</div>`;
    }
    if (!runtime.available) {
      return `<div class="gap-banner">OpenClaw runtime status unavailable${runtime.error ? ` — ${esc(runtime.error)}` : ""}. Agent status below is derived from task state only, not confirmed liveness.</div>`;
    }
    return "";
  }

  function learningPanel(learning) {
    if (!learning) {
      return `<section class="activity-panel"><div class="panel-heading"><div><span class="eyebrow">Company</span><h2>What has the company learned</h2></div></div><div class="empty-state">Learning findings unavailable.</div></section>`;
    }
    const items = learning.findings || [];
    return `<section class="activity-panel">
      <div class="panel-heading"><div><span class="eyebrow">Company</span><h2>What has the company learned</h2></div>${learning.count ? pill(learning.count, "badge-warn") : pill("None yet", "badge-type")}</div>
      ${items.length
        ? items.slice(0, 8).map((f) => `<div class="feed-item"><strong>${esc(f.title || f.summary || "Untitled finding")}</strong>${f.status ? ` ${pill(f.status, f.status === "accepted" ? "health-healthy" : "badge-type")}` : ""}${f.detail ? `<p>${esc(f.detail)}</p>` : ""}</div>`).join("")
        : `<div class="empty-state">No company-level learning findings yet.</div>`}
    </section>`;
  }

  function blindSpotsPanel(state) {
    const warnings = state.warnings || [];
    const discovered = state.discovery?.proposals || [];
    if (!warnings.length && !discovered.length) {
      return `<section class="activity-panel"><div class="panel-heading"><div><span class="eyebrow">Honesty check</span><h2>Where the system is blind</h2></div></div><div class="empty-state">No blind spots reported right now.</div></section>`;
    }
    return `<section class="activity-panel">
      <div class="panel-heading"><div><span class="eyebrow">Honesty check</span><h2>Where the system is blind</h2></div>${pill(warnings.length + discovered.length, "badge-warn")}</div>
      ${warnings.map((w) => `<div class="feed-item danger"><p>${esc(w.message)}</p></div>`).join("")}
      ${discovered.map((d) => `<div class="feed-item"><p>Unregistered repository found: ${esc(d.name)} (${esc(d.repo)}) — not yet in factory/projects.json.</p></div>`).join("")}
    </section>`;
  }

  function stageVerb(stage) { return ({ product: "shaping", architect: "analyzing", builder: "implementing", reviewer: "reviewing", qa: "testing", security: "checking", release: "preparing" })[stage] || "working on"; }
  function healthPill(health) {
    if (!health) return "";
    const cls = health.level === "healthy" ? "health-healthy" : health.level === "at-risk" ? "health-failed" : "badge-warn";
    return `<span><small>Health</small>${pill(`${health.score}/100`, cls)}</span>`;
  }

  function projectControlRow(p) {
    const active = (p.activeTasks || [])[0] || null;
    const blocked = (p.blockedTasks || [])[0] || null;
    const topRisk = (p.risks || []).slice().sort(riskSeverityOrder)[0];
    const openDecisions = (p.openDecisions || []).length;
    return `<article class="project-control">
      <div class="project-control-main"><span class="project-dot ${blocked ? "blocked" : p.status}"></span><div><h3>${esc(p.name)}</h3>
        ${p.mission ? `<p class="muted small">${esc(p.mission)}</p>` : ""}
        <p>${esc(active?.objective || "No active task")}</p></div></div>
      <div class="project-facts">
        <span><small>Status</small>${pill(p.status, blocked ? "health-failed" : "health-healthy")}</span>
        ${healthPill(p.health)}
        <span><small>Stage</small><strong>${esc(active?.stage || "—")}</strong></span>
        <span><small>GitHub</small><strong>${esc(p.github ? (p.externalSummary || "Configured") : "Not configured")}</strong></span>
      </div>
      ${!p.hasContext ? `<div class="project-intel-line muted small">Project context incomplete${(p.contextFindings || []).some((f) => f.code === "context-dir-missing") ? " — no context/ directory" : ""}.</div>` : ""}
      ${(topRisk || openDecisions) ? `<div class="project-intel-line muted small">${topRisk ? `Top risk: ${esc(topRisk.title)}${topRisk.unmitigated ? " (unmitigated)" : ""}` : ""}${topRisk && openDecisions ? " · " : ""}${openDecisions ? `${openDecisions} open decision${openDecisions === 1 ? "" : "s"}` : ""}</div>` : ""}
      ${blocked ? `<div class="project-blocker">${esc(blocked.objective || "Blocked")}</div>` : ""}
      <a class="btn secondary" href="#/project/${encodeURIComponent(p.key)}">Open →</a>
    </article>`;
  }

  function recommendedActions(company) {
    if (!company) return "";
    // The task-blocker decisions already render as cards above; don't repeat them.
    const items = (company.recommendedActions || []).filter((a) => !a.ref?.statePath).slice(0, 6);
    const risks = company.summary?.unmitigatedRisks || 0;
    const opps = company.summary?.opportunities || 0;
    if (!items.length && !risks && !opps) return "";
    return `<div class="rec-actions">
      <div class="panel-subhead"><span class="eyebrow">Recommended</span>${risks ? pill(`${risks} unmitigated risk${risks === 1 ? "" : "s"}`, "badge-warn") : ""}${opps ? pill(`${opps} opportunit${opps === 1 ? "y" : "ies"}`, "badge-type") : ""}</div>
      ${items.map((a) => `<div class="rec-action"><strong>${esc(a.action)}</strong><span class="muted small">${esc(a.project || "company")} · ${esc(a.rationale || "")}</span></div>`).join("") || `<div class="muted small">No open risks or opportunities.</div>`}
    </div>`;
  }

  function decisionCard(x) {
    const actionable = Boolean(x.statePath);
    return `<article class="decision-card">
      <div class="decision-top"><span class="decision-icon">!</span><div><strong>${esc(x.question)}</strong><span>${esc(x.project || "company")}${x.taskId ? ` · ${esc(x.taskId)}` : ""}</span></div></div>
      <p>${esc(x.why || "")}</p>
      ${(x.options || []).length ? `<div class="decision-options">${x.options.map((option) => `<span>${esc(option)}</span>`).join("")}</div>` : ""}
      ${x.recommendation ? `<div class="decision-rec"><small>Recommendation</small>${esc(x.recommendation)}</div>` : ""}
      ${actionable
        ? (x.risk === "high"
            ? `<p class="muted small">The private signing key stays outside OpenClaw and this dashboard.</p><button class="btn" data-approve-decision="${esc(x.statePath)}">Submit signed approval</button>`
            : `<button class="btn" data-resolve-decision="${esc(x.statePath)}">Respond & resume</button>`)
        : `<p class="muted small">Strategic decision tracked in ${esc(x.project || "the project")}'s ownership.json — not resolvable from here yet; update the file directly.</p>`}
    </article>`;
  }

  function bindFounderControls() {
    const project = document.getElementById("founder-project");
    project.onchange = () => { const repo = project.selectedOptions[0]?.dataset.repo; if (repo) document.getElementById("founder-repo").value = repo; };
    document.getElementById("founder-command").onsubmit = async (e) => { e.preventDefault(); try { const j = await apiJson("/api/founder/tasks", { method: "POST", body: JSON.stringify({ objective: document.getElementById("founder-objective").value, projectId: project.value, repo: document.getElementById("founder-repo").value }) }); showToast(`Work started: ${j.job.id}`); setTimeout(route, 1200); } catch (err) { showToast(err.message, true); } };
    app.querySelectorAll("[data-resolve-decision]").forEach((btn) => btn.onclick = () => { openModal("Founder decision", `<label class="field-label">Direction for the team</label><textarea class="editor" id="decision-direction" placeholder="Approve the recommended option because…"></textarea><button class="btn" id="submit-decision">Send decision & resume</button>`); document.getElementById("submit-decision").onclick = async () => { try { await apiJson("/api/founder/decisions/resolve", { method: "POST", body: JSON.stringify({ statePath: btn.dataset.resolveDecision, direction: document.getElementById("decision-direction").value }) }); closeModal(); showToast("Decision recorded. Work resumed."); route(); } catch (e) { showToast(e.message, true); } }; });
    app.querySelectorAll("[data-approve-decision]").forEach((btn) => btn.onclick = () => { openModal("Signed founder approval", `<p class="muted small">Create the assertion with <code>factory-sign-approval.mjs</code>, then submit its path and the matching evidence path inside the task worktree.</p><label class="field-label">Approval assertion path</label><input class="modal-input" id="approval-assertion" placeholder="/private/operator/approval.json"/><label class="field-label">Evidence path (relative to worktree)</label><input class="modal-input" id="approval-evidence" placeholder="evidence/founder-approval.md"/><button class="btn" id="submit-approval">Verify & approve</button>`); document.getElementById("submit-approval").onclick = async () => { try { await apiJson("/api/founder/decisions/approve", { method: "POST", body: JSON.stringify({ statePath: btn.dataset.approveDecision, approvalAssertionPath: document.getElementById("approval-assertion").value, evidence: document.getElementById("approval-evidence").value }) }); closeModal(); showToast("Signature verified. Work resumed."); route(); } catch (e) { showToast(e.message, true); } }; });
    document.getElementById("ask-agent").onclick = () => { openModal("Ask an agent", `<label class="field-label">Agent</label><input class="modal-input" id="question-agent" value="main"/><label class="field-label">Question</label><textarea class="editor" id="question-text" placeholder="What is blocking this project?"></textarea><button class="btn" id="send-question">Ask</button><div id="question-answer"></div>`); document.getElementById("send-question").onclick = async () => { const out = document.getElementById("question-answer"); out.innerHTML = `<p class="muted">Agent is thinking…</p>`; try { const j = await apiJson("/api/founder/questions", { method: "POST", body: JSON.stringify({ agentId: document.getElementById("question-agent").value, question: document.getElementById("question-text").value }) }); out.innerHTML = `<div class="card">${esc(j.question.answer)}</div>`; } catch (e) { out.innerHTML = `<p class="danger-text">${esc(e.message)}</p>`; } }; };
  }

  function renderAgentRail(agents, runtime) {
    const list = (agents || []).slice(0, 14);
    return `
      <aside class="agent-rail">
        <div class="rail-title">HQ Team</div>
        <input class="rail-filter" placeholder="Filter agents..." disabled />
        ${list.map((a) => `
          <div class="rail-agent">
            <div class="avatar">${esc((a.name || "?").slice(0, 2))}</div>
            <div>
              <strong>${esc(a.name)}</strong>
              <span>${esc(a.role)} · ${esc(a.harness || "—")}</span>
              <em>${esc(railStatus(a, runtime))}</em>
            </div>
          </div>`).join("")}
      </aside>`;
  }

  function railStatus(a, runtime) {
    if (a.harnessAvailable === false) return `${a.status} (${a.harness} unavailable → ${a.harnessFallback || "fallback"})`;
    if (!runtime || !runtime.available) return a.status;
    if (a.runtimeAgentId && !a.runtimeResolved) return `${a.status} (no live OpenClaw agent)`;
    return a.status;
  }

  // ── Agents: organizational roles vs. the real OpenClaw runtime ─

  async function renderAgents() {
    const [state, labAgents] = await Promise.all([
      loadCompany(),
      apiJson("/api/agents").catch(() => ({ agents: [] })),
    ]);
    const agents = state.agents?.agents || [];
    const runtime = state.runtime;
    const reconciliation = state.rosterReconciliation;

    app.innerHTML = `
      <h1 class="page-title">Agents</h1>
      <p class="muted">Organizational roles are Headquarters' committed workforce roster (factory/agents.json). The runtime roster below is what OpenClaw itself reports right now — they are not always the same thing.</p>
      ${runtimeBanner(runtime)}
      <h2 class="section-title">Organizational roles</h2>
      <div class="agent-grid">
        ${agents.map((a) => orgRoleCard(a, runtime)).join("") || `<div class="empty-state">No agents in factory/agents.json.</div>`}
      </div>

      <h2 class="section-title">Real OpenClaw runtime roster</h2>
      ${runtimeRosterTable(runtime, reconciliation)}

      <h2 class="section-title">Agent Lab (runnable agent folders)</h2>
      <p class="muted small">The only mechanism in this repo that actually executes an agent as a standalone process — distinct from the organizational roster above.</p>
      ${agentLabGrid(labAgents.agents || [])}
    `;
    app.querySelectorAll("[data-run-existing]").forEach((btn) => {
      btn.onclick = () => {
        const [project, id] = btn.dataset.runExisting.split("/");
        runAgent(project, id, false);
      };
    });
  }

  function statusBadgeClass(status) {
    if (status === "working") return "health-healthy";
    if (status === "blocked" || status === "failed") return "health-failed";
    if (status === "stale" || status === "waiting" || status === "needs-founder") return "badge-warn";
    return "badge-type";
  }

  function runtimeNoteFor(a, runtime) {
    if (!runtime) return "Runtime status unavailable";
    if (!runtime.available) return `Runtime status unavailable${runtime.error ? ` (${runtime.error})` : ""}`;
    if (!a.runtimeAgentId) return "No runtimeAgentId assigned";
    if (!a.runtimeResolved) return `Live: no OpenClaw agent named "${a.runtimeAgentId}"`;
    return a.running ? "Live: running now" : "Live: not currently running";
  }

  function harnessLine(a) {
    if (a.harnessAvailable === false) {
      return `${esc(a.harness || "—")} ${pill("unavailable", "badge-warn")}${a.harnessFallback ? ` → falling back to ${esc(a.harnessFallback)}` : ""}`;
    }
    return esc(a.harness || "—");
  }

  function orgRoleCard(a, runtime) {
    return `
      <article class="agent-card">
        <div class="agent-card-head">
          <div class="avatar large">${esc((a.name || "?").slice(0, 2))}</div>
          <div><h3>${esc(a.name)}</h3><p>${esc(a.role)}</p></div>
          ${pill(a.status, statusBadgeClass(a.status))}
        </div>
        ${a.harnessAvailable === false ? `<div class="gap-banner">Intended harness "${esc(a.harness)}" is currently unavailable — running on "${esc(a.harnessFallback || "an unspecified fallback")}" instead.</div>` : ""}
        <dl class="meta-grid">
          <dt>Harness</dt><dd>${harnessLine(a)}</dd>
          <dt>Runtime agent id</dt><dd>${esc(a.runtimeAgentId || "—")}</dd>
          <dt>Runtime</dt><dd>${esc(runtimeNoteFor(a, runtime))}</dd>
          <dt>Current project</dt><dd>${esc(a.currentProject || "—")}</dd>
          <dt>Current task</dt><dd>${esc(a.currentTask?.objective || "—")}</dd>
          <dt>Stage</dt><dd>${esc(a.currentTask?.stage || "—")}</dd>
          <dt>Blocker</dt><dd>${esc(a.blocker || "—")}</dd>
          <dt>Last activity</dt><dd>${esc(a.lastActivityAt ? fmtTime(a.lastActivityAt) : "—")}</dd>
        </dl>
      </article>`;
  }

  function runtimeRosterTable(runtime, reconciliation) {
    if (!runtime) return `<div class="empty-state">Runtime awareness is disabled in factory/hq.config.json.</div>`;
    if (!runtime.available) return `<div class="empty-state">OpenClaw runtime status unavailable: ${esc(runtime.error || "openclaw CLI unreachable")}.</div>`;
    if (!runtime.agents.length) return `<div class="empty-state">OpenClaw reports no agent workspaces right now.</div>`;
    return `<div class="table-wrap"><table class="runtime-table">
      <thead><tr><th>OpenClaw agent id</th><th>Identity</th><th>Model</th><th>Organizational role</th></tr></thead>
      <tbody>
        ${runtime.agents.map((r) => {
          const role = (reconciliation?.roles || []).find((x) => x.runtimeAgentId === r.id && x.resolved);
          return `<tr><td>${esc(r.id)}</td><td>${esc(r.identity)}</td><td>${esc(r.model || "—")}</td><td>${role ? esc(role.role) : `<span class="muted">Unassigned — no org role names this agent</span>`}</td></tr>`;
        }).join("")}
      </tbody>
    </table></div>
    ${(reconciliation?.roles || []).some((r) => r.runtimeAgentId && !r.resolved) ? `<p class="muted small">Some organizational roles name an OpenClaw agent id that does not currently exist in this machine's install — see the honesty-check panel on Today.</p>` : ""}`;
  }

  function agentLabGrid(list) {
    if (!list.length) return `<div class="empty-state">No agents registered in the Agent Lab (agents/&lt;project&gt;/&lt;id&gt;/).</div>`;
    return `<div class="agent-grid">${list.map((a) => `
      <article class="agent-card">
        <div class="agent-card-head"><div class="avatar large">${esc((a.config?.name || a.id || "?").slice(0, 2))}</div><div><h3>${esc(a.config?.name || a.id)}</h3><p>${esc(a.project)}/${esc(a.id)}</p></div></div>
        <div class="row-actions"><button class="btn" data-run-existing="${esc(a.project)}/${esc(a.id)}">Run now</button></div>
      </article>`).join("")}</div>`;
  }

  // ── Projects: real registry + intelligence ─────────────────────

  async function renderProjects() {
    const state = await loadCompany();
    const projects = state.projects || [];
    app.innerHTML = `
      <div class="page-head">
        <div>
          <h1 class="page-title">Projects</h1>
          <p class="muted">Real projects from factory/projects.json. Click a card to open its full intelligence profile.</p>
        </div>
      </div>
      ${state.headquarters ? `<div class="hq-infra-note muted small">${esc(state.headquarters.name)} is Headquarters infrastructure, not a project — it is not listed below. See Today for its status.</div>` : ""}
      <div class="project-grid">
        ${projects.map((p) => {
          const href = `#/project/${encodeURIComponent(p.key)}`;
          return `
          <article class="project-card project-card-link" data-href="${esc(href)}">
            <div class="card-head">
              <div style="min-width:0">
                <h3 class="card-title">${esc(p.name)}</h3>
                <div class="card-meta">${esc(p.status)}${p.health ? ` · Health ${p.health.score}/100` : ""}</div>
              </div>
              <a class="btn" href="${esc(href)}">Open →</a>
            </div>
            <p style="margin:0.6rem 0 0.75rem">${esc(p.mission || "")}</p>
            <div class="proj-stats-row">
              <span class="proj-stat">${(p.activeTasks || []).length} active task${(p.activeTasks || []).length === 1 ? "" : "s"}</span>
              ${(p.blockedTasks || []).length ? `<span class="proj-stat proj-stat-red">${p.blockedTasks.length} blocked</span>` : ""}
              ${!p.hasContext ? `<span class="proj-stat proj-stat-amber">context incomplete</span>` : ""}
              <span class="proj-stat proj-stat-muted">${p.github ? "GitHub configured" : "GitHub not configured"}</span>
            </div>
          </article>`;
        }).join("") || `<div class="empty-state">No projects registered.</div>`}
      </div>`;

    app.querySelectorAll(".project-card-link").forEach((card) => {
      card.onclick = (e) => {
        if (e.target.closest("a, button")) return;
        location.hash = card.dataset.href.replace(/^#/, "");
      };
    });
  }

  function renderIntelSection(title, items) {
    if (!items || !items.length) return "";
    return `<section class="profile-section"><h2 class="section-title">${esc(title)}</h2><ul class="intel-list">${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul></section>`;
  }

  function renderCompanyTaskMinis(p) {
    const all = [...(p.blockedTasks || []), ...(p.activeTasks || [])];
    if (!all.length) return `<p class="muted small">No active factory tasks.</p>`;
    return all.slice(0, 8).map((t) => `
      <div class="task-mini ${t.status === "blocked" ? "task-mini-blocked" : ""}">
        <div class="tm-title">${esc(t.objective || t.id)}</div>
        <div class="tm-meta">${pill(t.stage || "?", "badge-type")}${pill(t.status, t.status === "blocked" ? "health-failed" : "badge-type")}</div>
      </div>`).join("");
  }

  function renderGithubPanel(p) {
    if (!p.github) return `<p class="muted small">GitHub repository not configured.</p>`;
    const ext = p.external;
    if (!ext) {
      // The Headquarters row carries only a summary line, not the full
      // per-project external object (see hq/company-state.mjs).
      if (p.externalSummary) return `<p class="muted small">${esc(p.externalSummary)}</p>`;
      return `<p class="muted small">GitHub configured (${esc(p.github.owner)}/${esc(p.github.repo)}) — awareness not requested.</p>`;
    }
    if (!ext.available) return `<p class="muted small">GitHub unavailable: ${esc(ext.warnings?.[0]?.message || "unknown error")}</p>`;
    return `
      <p class="muted small">${esc(ext.summary || "")}</p>
      ${ext.repoInfo ? `<p class="muted small"><a href="${esc(ext.repoInfo.url)}" target="_blank" rel="noopener">${esc(ext.repoInfo.name)}</a> · default branch ${esc(ext.repoInfo.defaultBranch || "—")}</p>` : ""}
      ${(ext.commits || []).slice(0, 3).map((c) => `<div class="feed-item"><strong>${esc(c.message)}</strong><div class="muted small">${esc(c.author)} · ${esc(fmtTime(c.date))}</div></div>`).join("")}
      ${(ext.pullRequests || []).length ? `<p class="muted small">${ext.pullRequests.length} open PR(s)</p>` : ""}
      ${(ext.issues || []).length ? `<p class="muted small">${ext.issues.length} open issue(s)</p>` : ""}
    `;
  }

  async function renderProject(route) {
    let state;
    try {
      state = await loadCompany();
    } catch (e) {
      app.innerHTML = `<p class="muted">Error loading company state: ${esc(String(e.message || e))}</p>`;
      return;
    }

    let p = (state.projects || []).find((x) => x.key === route.id);
    let isHq = false;
    if (!p && state.headquarters?.key === route.id) {
      p = state.headquarters;
      isHq = true;
    }
    if (!p) {
      app.innerHTML = `<p class="profile-back"><a href="#/projects">← Projects</a></p><p class="muted">Project not found in factory/projects.json: ${esc(route.id)}</p>`;
      return;
    }

    const intel = p.intelligence || null;
    const responsibleAgents = (p.responsibleAgents || [])
      .map((id) => (state.agents.agents || []).find((a) => a.id === id))
      .filter(Boolean);

    app.innerHTML = `
      <div class="profile-back"><a href="#/projects">← Projects</a></div>

      <div class="page-head" style="margin-top:0.5rem">
        <div>
          <h1 class="page-title">${esc(p.name)}</h1>
          <div class="profile-meta">
            ${pill(p.key, "badge-type")}
            ${isHq ? pill("Headquarters infrastructure", "badge-type") : pill(p.status, "badge-type")}
            ${!isHq && p.health ? pill(`Health ${p.health.score}/100`, p.health.level === "healthy" ? "health-healthy" : p.health.level === "at-risk" ? "health-failed" : "badge-warn") : ""}
          </div>
        </div>
      </div>

      <div class="profile-stats">
        <div class="pstat"><div class="pstat-val">${(p.activeTasks || []).length}</div><div class="pstat-label">Active Tasks</div></div>
        <div class="pstat ${(p.blockedTasks || []).length ? "pstat-warn" : ""}"><div class="pstat-val">${(p.blockedTasks || []).length}</div><div class="pstat-label">Blocked</div></div>
        <div class="pstat ${(p.openDecisions || []).length ? "pstat-action" : ""}"><div class="pstat-val">${(p.openDecisions || []).length}</div><div class="pstat-label">Open Decisions</div></div>
        <div class="pstat"><div class="pstat-val">${responsibleAgents.length}</div><div class="pstat-label">Responsible agents</div></div>
        <div class="pstat pstat-muted"><div class="pstat-val">${p.hasContext ? "Yes" : "No"}</div><div class="pstat-label">Has context</div></div>
      </div>

      <div class="profile-grid">
        <div class="profile-main">

          <section class="profile-section">
            <h2 class="section-title">Overview</h2>
            <p>${esc(p.mission || "No mission recorded.")}</p>
            ${intel?.vision?.statement ? `<p class="muted small"><strong>Vision:</strong> ${esc(intel.vision.statement)}</p>` : ""}
            ${intel?.roadmap?.current ? `<p class="muted small"><strong>Current:</strong> ${esc(intel.roadmap.current)}</p>` : ""}
          </section>

          ${!p.hasContext ? `<section class="profile-section"><h2 class="section-title">Context gap</h2><div class="feed-item danger"><p>This project has no readable context/ directory, or it is missing critical files. The intelligence layer cannot give agents mission, roadmap, or decision context for it. Nothing here has been invented to fill the gap.</p></div></section>` : ""}

          ${(p.contextFindings || []).length ? `<section class="profile-section"><h2 class="section-title">Context findings</h2>${p.contextFindings.map((f) => `<div class="feed-item ${f.severity === "error" ? "danger" : ""}"><p>${esc(f.file || "context/")}: ${esc(f.message)}</p></div>`).join("")}</section>` : ""}

          ${renderIntelSection("Roadmap", intel?.roadmap ? [
            intel.roadmap.next?.length ? `Next: ${intel.roadmap.next.join("; ")}` : null,
            intel.roadmap.later?.length ? `Later: ${intel.roadmap.later.join("; ")}` : null,
            intel.roadmap.deferred?.length ? `Deferred: ${intel.roadmap.deferred.join("; ")}` : null,
          ].filter(Boolean) : null)}

          ${renderIntelSection("Recent decisions", (intel?.decisions || []).slice(0, 5).map((d) => `${d.id ? `${d.id} — ` : ""}${d.title}${d.summary ? `: ${d.summary}` : ""}`))}

          ${renderIntelSection("Memory", intel?.memory)}

          ${intel?.techContext ? `<section class="profile-section"><h2 class="section-title">Technical context</h2><p class="muted small">${esc(intel.techContext)}</p></section>` : ""}
          ${intel?.users ? `<section class="profile-section"><h2 class="section-title">Users</h2><p class="muted small">${esc(intel.users)}</p></section>` : ""}
          ${intel?.competitiveContext ? `<section class="profile-section"><h2 class="section-title">Competitive context</h2><p class="muted small">${esc(intel.competitiveContext)}</p></section>` : ""}

          <section class="profile-section">
            <h2 class="section-title">Risks</h2>
            ${(p.risks || []).length
              ? p.risks.map((r) => `<div class="feed-item ${r.unmitigated ? "danger" : ""}"><strong>${esc(r.title)}</strong> ${pill(r.severity, r.severity === "high" ? "health-failed" : "badge-warn")}${r.unmitigated ? ` ${pill("unmitigated", "badge-warn")}` : ""}${r.mitigation ? `<p>${esc(r.mitigation)}</p>` : ""}</div>`).join("")
              : `<p class="muted small">No risks recorded in ownership.json.</p>`}
          </section>

          <section class="profile-section">
            <h2 class="section-title">Responsible agents</h2>
            ${responsibleAgents.length ? `<div class="agent-grid">${responsibleAgents.map((a) => orgRoleCard(a, state.runtime)).join("")}</div>` : `<p class="muted small">No responsible agents recorded.</p>`}
          </section>

        </div>

        <div class="profile-sidebar">
          <div class="sidebar-card">
            <h2 class="section-title">Tasks</h2>
            ${renderCompanyTaskMinis(p)}
          </div>

          <div class="sidebar-card">
            <h2 class="section-title">GitHub</h2>
            ${renderGithubPanel(p)}
          </div>

          ${(p.openDecisions || []).length ? `<div class="sidebar-card"><h2 class="section-title">Open decisions</h2>${p.openDecisions.map((id) => `<div class="feed-item"><p>${esc(id)}</p></div>`).join("")}</div>` : ""}
        </div>
      </div>`;
  }

  // ── Task Board / SOPs / Reports — legacy example data ──────────

  async function renderTasks() {
    const d = await loadHq();
    app.innerHTML = `
      ${demoBanner()}
      <div class="page-head">
        <div>
          <h1 class="page-title">Task Board</h1>
          <p class="muted">Inbox, Assigned, In Progress, Review, Done, and Blocked. Example data seeded by scripts/seed-hq.sh — not the real factory task pipeline.</p>
        </div>
        <button class="btn secondary" id="edit-tasks">Edit tasks JSON</button>
      </div>
      <div class="kanban">
        ${BOARD_COLUMNS.map((col) => {
          const tasks = d.tasks.filter((t) => t.status === col);
          return `
            <section class="kanban-col">
              <div class="kanban-head"><span>${esc(col)}</span><b>${tasks.length}</b></div>
              ${tasks.map((t) => taskCard(t, d.projects, d.agents)).join("") || `<p class="muted small">No tasks.</p>`}
            </section>`;
        }).join("")}
      </div>`;
    document.getElementById("edit-tasks").onclick = () => editCollection("tasks", d.tasks);
  }

  async function renderSops() {
    const d = await loadHq();
    app.innerHTML = `
      ${demoBanner()}
      <div class="page-head">
        <div><h1 class="page-title">SOPs</h1><p class="muted">Example operating procedures seeded for demo purposes — not real company SOPs.</p></div>
        <button class="btn secondary" id="edit-sops">Edit SOPs JSON</button>
      </div>
      ${["global", "project"].map((scope) => `
        <h2 class="section-title">${scope === "global" ? "Global SOPs" : "Project SOPs"}</h2>
        ${(d.sops || []).filter((s) => s.scope === scope).map((s) => `
          <article class="card">
            <div class="card-head">
              <div><h3 class="card-title">${esc(s.title)}</h3><div class="card-meta">${esc(projectName(d.projects, s.projectId))} · Owner: ${esc(agentName(d.agents, s.ownerAgent))}</div></div>
            </div>
            <p>${esc(s.body)}</p>
          </article>`).join("") || `<p class="muted">No ${esc(scope)} SOPs yet.</p>`}
      `).join("")}`;
    document.getElementById("edit-sops").onclick = () => editCollection("sops", d.sops);
  }

  async function renderLogs() {
    const d = await loadHq();
    const runRows = await apiJson("/api/runs?limit=20").catch(() => ({ runs: [] }));
    app.innerHTML = `
      <h1 class="page-title">Logs</h1>
      <div class="log-grid">
        ${logSection("Daily / Decision / Task Logs (example data)", d.logs, d)}
        ${logSection("Agent Run Logs (real — Agent Lab)", (runRows.runs || []).map((r) => ({
          type: "agent-run",
          title: `${r.agent_key} ${r.status}`,
          detail: r.summary || r.error_message || "",
          createdAt: r.started_at,
          source: "agent-lab"
        })), d)}
      </div>`;
  }

  function logSection(title, rows, d) {
    return `
      <section>
        <h2 class="section-title">${esc(title)}</h2>
        ${(rows || []).map((l) => `
          <div class="feed-item">
            ${pill(l.type || "log", l.type === "error" ? "health-failed" : "badge-type")}
            <strong>${esc(l.title)}</strong>
            <div class="muted small">${esc(projectName(d.projects || [], l.projectId))} · ${esc(agentName(d.agents || [], l.agentId))} · ${esc(fmtTime(l.createdAt))}</div>
            <p>${esc(l.detail)}</p>
          </div>`).join("") || `<p class="muted">No logs.</p>`}
      </section>`;
  }

  async function renderReports() {
    const d = await loadHq();
    app.innerHTML = `
      ${demoBanner()}
      <div class="page-head">
        <div><h1 class="page-title">Reports</h1><p class="muted">Example daily/CEO/weekly reports seeded for demo purposes — no real reports have been generated yet.</p></div>
        <button class="btn secondary" id="edit-reports">Edit reports JSON</button>
      </div>
      ${["daily-brief", "project-ceo-report", "weekly-project-review"].map((type) => `
        <h2 class="section-title">${esc(reportLabel(type))}</h2>
        ${(d.reports || []).filter((r) => r.type === type).map((r) => `
          <article class="card">
            <div class="card-head">
              <div><h3 class="card-title">${esc(r.title)}</h3><div class="card-meta">${esc(projectName(d.projects, r.projectId))} · ${esc(agentName(d.agents, r.agentId))} · ${esc(fmtTime(r.createdAt))}</div></div>
            </div>
            <p><strong>${esc(r.summary)}</strong></p>
            <p>${esc(r.body)}</p>
          </article>`).join("") || `<p class="muted">No reports yet.</p>`}
      `).join("")}`;
    document.getElementById("edit-reports").onclick = () => editCollection("reports", d.reports);
  }

  function reportLabel(type) {
    if (type === "daily-brief") return "Charles Daily Brief";
    if (type === "project-ceo-report") return "Project CEO Reports";
    return "Weekly Project Reviews";
  }

  async function editCollection(name, value) {
    openModal(`Edit ${name}`, `
      <p class="muted">Edit carefully. This writes <code>dashboard/backend/data/hq/${esc(name)}.json</code>.</p>
      <textarea class="editor tall" id="collection-editor">${esc(JSON.stringify(value, null, 2))}</textarea>
      <div class="row-actions"><button class="btn" id="save-collection">Save</button></div>`);
    document.getElementById("save-collection").onclick = async () => {
      try {
        const parsed = JSON.parse(document.getElementById("collection-editor").value);
        await apiJson(`/api/hq/${encodeURIComponent(name)}`, {
          method: "PUT",
          body: JSON.stringify({ [name]: parsed }),
        });
        closeModal();
        showToast(`${name} saved.`);
        route();
      } catch (e) {
        showToast(String(e.message || e), true);
      }
    };
  }

  // ── Runs — real Agent Lab run history ───────────────────────────

  async function renderRuns() {
    const d = await apiJson("/api/runs?limit=80");
    app.innerHTML = `
      <h1 class="page-title">Runs</h1>
      <p class="muted">Real Agent Lab run history.</p>
      <div class="timeline">
        ${(d.runs || []).map((r) => `
          <div class="timeline-item ${r.status}">
            <div><strong>${esc(r.agent_key)}</strong> · ${pill(r.status, r.status === "success" ? "health-healthy" : r.status === "failed" ? "health-failed" : "badge-type")}</div>
            <div class="muted small">${esc(fmtTime(r.started_at))}</div>
            <div class="small">${esc(r.summary || r.error_message || "")}</div>
            <a href="#/run/${r.id}">Open run</a>
          </div>`).join("") || `<p class="muted">No runs yet.</p>`}
      </div>`;
  }

  async function renderRunDetail(route) {
    const d = await apiJson("/api/runs/" + route.id);
    const r = d.run;
    app.innerHTML = `
      <p><a href="#/runs">Back to Runs</a></p>
      <h1 class="page-title">Run #${r.id}</h1>
      <div class="card">
        <p><strong>Agent</strong> ${esc(r.project)}/${esc(r.agentId)}</p>
        <p><strong>Status</strong> ${esc(r.status)}</p>
        <p><strong>Started</strong> ${esc(fmtTime(r.started_at))}</p>
        <p><strong>Ended</strong> ${esc(fmtTime(r.ended_at))}</p>
        <p><strong>Summary</strong> ${esc(r.summary || "-")}</p>
        <p><strong>Error</strong> ${esc(r.error_message || "-")}</p>
      </div>
      <h2 class="section-title">Log tail</h2>
      <pre class="code">${esc(d.logTail || "")}</pre>
      ${d.outputHtml ? `<h2 class="section-title">Output</h2><div class="card md-body">${d.outputHtml}</div>` : ""}`;
  }

  async function renderLabAgent(route) {
    const a = await apiJson(`/api/agents/${encodeURIComponent(route.project)}/${encodeURIComponent(route.id)}`);
    app.innerHTML = `
      <p><a href="#/agents">Back to Agents</a></p>
      <h1 class="page-title">${esc(a.config.name || a.id)}</h1>
      <p class="muted">${esc(route.project)} / ${esc(route.id)}</p>
      <div class="card">
        <p>${esc(a.config.description || "")}</p>
        <p><strong>Status</strong> ${esc(a.config.status || "-")} · <strong>Type</strong> ${esc(a.config.type || "-")}</p>
        <p><strong>Last run</strong> ${esc(a.lastRun?.status || "-")} · ${esc(fmtTime(a.lastRun?.ended_at || a.lastRun?.started_at))}</p>
        <div class="row-actions">
          <button class="btn" id="run-lab-agent">Run now</button>
          <a class="btn secondary" href="#/runs">Run history</a>
        </div>
      </div>
      <h2 class="section-title">Latest output</h2>
      <pre class="code">${esc(a.lastMarkdownOutput?.preview?.snippet || "No markdown output yet.")}</pre>`;
    document.getElementById("run-lab-agent").onclick = () => runAgent(route.project, route.id, false);
  }

  async function runAgent(project, id, wait) {
    try {
      const q = wait ? "?wait=1" : "";
      const j = await apiJson(`/api/admin/agents/${encodeURIComponent(project)}/${encodeURIComponent(id)}/run${q}`, {
        method: "POST",
        body: "{}",
      });
      showToast(j.ok ? "Run finished successfully." : "Run reported failure.", !j.ok);
    } catch (e) {
      showToast(String(e.message || e), true);
    }
  }

  async function route() {
    const r = parseRoute();
    setNavActive(r);
    try {
      if (r.name === "today") await renderToday();
      else if (r.name === "agents") await renderAgents();
      else if (r.name === "projects") await renderProjects();
      else if (r.name === "project") await renderProject(r);
      else if (r.name === "tasks") await renderTasks();
      else if (r.name === "sops") await renderSops();
      else if (r.name === "logs") await renderLogs();
      else if (r.name === "reports") await renderReports();
      else if (r.name === "runs") await renderRuns();
      else if (r.name === "run") await renderRunDetail(r);
      else if (r.name === "agent") await renderLabAgent(r);
      else await renderToday();
    } catch (e) {
      app.innerHTML = `<p class="muted">Error loading page: ${esc(e.message)}</p>`;
    }
  }

  async function boot() {
    const me = await fetch("/api/auth/me", { credentials: "include" });
    let j = {};
    try {
      j = JSON.parse(await me.text());
    } catch {
      j = {};
    }
    if (!j.authenticated) {
      location.href = "/login.html";
      return;
    }
    buildNav();
    window.addEventListener("hashchange", route);
    await route();
    setInterval(() => {
      if (parseRoute().name === "today" && modal.hidden && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) route();
    }, 15000);
  }

  boot();
})();
