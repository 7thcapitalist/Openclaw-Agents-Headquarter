(function () {
  const app = document.getElementById("app");
  const nav = document.getElementById("nav");
  const toastEl = document.getElementById("toast");
  const modal = document.getElementById("modal");
  const modalTitle = document.getElementById("modal-title");
  const modalBody = document.getElementById("modal-body");

  const BOARD_COLUMNS = ["Inbox", "Assigned", "In Progress", "Review", "Done", "Blocked"];

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

  async function loadHq() {
    return apiJson("/api/hq");
  }

  function pill(text, kind) {
    return `<span class="badge ${kind || "badge-type"}">${esc(text)}</span>`;
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

  async function renderToday() {
    const [d, fc] = await Promise.all([loadHq(), apiJson("/api/founder/overview")]);
    const projects = fc.projects || [];
    const activeAgents = (fc.tasks || []).filter((t) => t.status === "active");
    app.innerHTML = `
      <section class="hq-layout">
        ${renderAgentRail(d.agents)}
        <main class="hq-main">
          <div class="founder-hero">
            <div class="eyebrow">Founder control plane</div>
            <h1>What should the company build next?</h1>
            <p>Give your team an outcome. OpenClaw will turn it into bounded work and route the right agents.</p>
            <form id="founder-command" class="founder-command">
              <textarea id="founder-objective" rows="2" placeholder="Build Fitbit integration for LifeMaxing" required></textarea>
              <div class="founder-command-row">
                <select id="founder-project" required>
                  <option value="">Choose project</option>
                  ${projects.map((p) => `<option value="${esc(p.id)}" data-repo="${esc(p.repo || "")}">${esc(p.name)}</option>`).join("")}
                </select>
                <input id="founder-repo" placeholder="Repository path" value="${esc(d.root || "")}" required />
                <button class="btn founder-launch" type="submit">Start work →</button>
              </div>
            </form>
          </div>
          <div class="control-stats">
            <div><strong>${projects.length}</strong><span>Projects</span></div>
            <div><strong>${activeAgents.length}</strong><span>Agents working</span></div>
            <div class="${fc.decisions.length ? "attention" : ""}"><strong>${fc.decisions.length}</strong><span>Need your input</span></div>
            <div><strong>${(fc.tasks || []).filter((t) => t.status === "merge-ready").length}</strong><span>Merge ready</span></div>
          </div>
          <div class="founder-grid">
            <section class="portfolio-panel">
              <div class="panel-heading"><div><span class="eyebrow">Portfolio</span><h2>Projects</h2></div><button class="btn secondary" id="new-project">+ New project</button></div>
              <div class="project-control-list">
                ${projects.map((p) => projectControlRow(p)).join("") || `<div class="empty-state">Create a project to begin.</div>`}
              </div>
            </section>
            <section class="inbox-panel">
              <div class="panel-heading"><div><span class="eyebrow">Founder inbox</span><h2>Decisions</h2></div>${fc.decisions.length ? pill(fc.decisions.length, "badge-warn") : pill("Clear", "health-healthy")}</div>
              ${(fc.decisions || []).map((x) => decisionCard(x)).join("") || `<div class="empty-state"><strong>Nothing needs you.</strong><span>Your agents have what they need to keep moving.</span></div>`}
              ${recommendedActions(fc.company)}
            </section>
          </div>
          <section class="activity-panel">
            <div class="panel-heading"><div><span class="eyebrow">Live company</span><h2>Agent activity</h2></div><button class="btn secondary" id="ask-agent">Ask an agent</button></div>
            <div class="company-feed">
              ${(fc.jobs || []).filter((job) => job.status === "starting" || job.status === "error").slice(0, 5).map((job) => `<div class="company-agent"><span class="activity-pulse ${job.status === "error" ? "pulse-error" : ""}"></span><div><strong>${esc(job.projectId)}</strong><span>${esc(job.objective)}</span></div><em class="${job.status === "error" ? "danger-text" : ""}">${esc(job.status)}</em></div>`).join("")}
              ${activeAgents.map((t) => `<div class="company-agent"><span class="activity-pulse"></span><div><strong>${esc(titleCase(t.agent || "agent"))}</strong><span>${esc(stageVerb(t.stage))} ${esc(t.objective)}</span></div><em>${esc(t.agentStatus)}</em></div>`).join("")}
              ${(fc.activity || []).slice(0, 8).map((e) => `<div class="company-event"><span>${esc(e.type.replaceAll("-", " "))}</span><strong>${esc(e.taskId)}</strong><time>${esc(fmtTime(e.at))}</time></div>`).join("") || `<div class="empty-state">No factory activity yet.</div>`}
            </div>
          </section>
        </main>
      </section>`;
    bindFounderControls();
  }

  function titleCase(value) { return String(value).replaceAll("-", " ").replace(/\b\w/g, (c) => c.toUpperCase()); }
  function stageVerb(stage) { return ({ product: "shaping", architect: "analyzing", builder: "implementing", reviewer: "reviewing", qa: "testing", security: "checking", release: "preparing" })[stage] || "working on"; }
  function healthPill(health) {
    if (!health) return "";
    const cls = health.level === "healthy" ? "health-healthy" : health.level === "at-risk" ? "health-failed" : "badge-warn";
    return `<span><small>Health</small>${pill(`${health.score}/100`, cls)}</span>`;
  }
  function projectControlRow(p) {
    const latest = p.tasks?.[0];
    const intel = p.intelligence || null;
    const mission = intel?.mission || p.mission || "";
    const topRisk = intel?.risks?.slice().sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.severity] ?? 3) - ({ high: 0, medium: 1, low: 2 }[b.severity] ?? 3))[0];
    const openDecisions = (intel?.ownership?.openDecisions || []).length;
    return `<article class="project-control ${p.status === "paused" ? "is-paused" : ""}">
      <div class="project-control-main"><span class="project-dot ${p.blocker ? "blocked" : p.status}"></span><div><h3>${esc(p.name)}</h3>
        ${mission ? `<p class="muted small">${esc(mission)}</p>` : ""}
        <p>${esc(latest?.objective || (intel?.roadmap?.current) || "No active task")}</p></div></div>
      <div class="project-facts"><span><small>Status</small>${pill(p.status, p.blocker ? "health-failed" : "health-healthy")}</span>${healthPill(p.health)}<span><small>Stage</small><strong>${esc(p.stage || "—")}</strong></span><span><small>Agent</small><strong>${esc(p.agent || "—")}</strong></span><span><small>Last activity</small><strong>${esc(p.lastActivity ? fmtTime(p.lastActivity) : "—")}</strong></span></div>
      ${(topRisk || openDecisions) ? `<div class="project-intel-line muted small">${topRisk ? `Top risk: ${esc(topRisk.title)}${topRisk.unmitigated ? " (unmitigated)" : ""}` : ""}${topRisk && openDecisions ? " · " : ""}${openDecisions ? `${openDecisions} open decision${openDecisions === 1 ? "" : "s"}` : ""}</div>` : ""}
      ${p.blocker ? `<div class="project-blocker">${esc(p.blocker.summary)}</div>` : ""}
      <button class="btn secondary" data-project-action="${p.status === "paused" ? "resume" : "pause"}" data-project-id="${esc(p.id)}">${p.status === "paused" ? "Resume" : "Pause"}</button>
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
    return `<article class="decision-card"><div class="decision-top"><span class="decision-icon">!</span><div><strong>${esc(x.question)}</strong><span>${esc(x.project)} · ${esc(x.taskId)}</span></div></div><p>${esc(x.why)}</p><div class="decision-options">${(x.options || []).map((option) => `<span>${esc(option)}</span>`).join("")}</div><div class="decision-rec"><small>Recommendation</small>${esc(x.recommendation)}</div>${x.risk === "high" ? `<p class="muted small">The private signing key stays outside OpenClaw and this dashboard.</p><button class="btn" data-approve-decision="${esc(x.statePath)}">Submit signed approval</button>` : `<button class="btn" data-resolve-decision="${esc(x.statePath)}">Respond & resume</button>`}</article>`;
  }

  function bindFounderControls() {
    const project = document.getElementById("founder-project");
    project.onchange = () => { const repo = project.selectedOptions[0]?.dataset.repo; if (repo) document.getElementById("founder-repo").value = repo; };
    document.getElementById("founder-command").onsubmit = async (e) => { e.preventDefault(); try { const j = await apiJson("/api/founder/tasks", { method: "POST", body: JSON.stringify({ objective: document.getElementById("founder-objective").value, projectId: project.value, repo: document.getElementById("founder-repo").value }) }); showToast(`Work started: ${j.job.id}`); setTimeout(route, 1200); } catch (err) { showToast(err.message, true); } };
    app.querySelectorAll("[data-project-action]").forEach((btn) => btn.onclick = async () => { try { await apiJson(`/api/founder/projects/${encodeURIComponent(btn.dataset.projectId)}/${btn.dataset.projectAction}`, { method: "POST", body: "{}" }); showToast(`Project ${btn.dataset.projectAction}d.`); route(); } catch (e) { showToast(e.message, true); } });
    app.querySelectorAll("[data-resolve-decision]").forEach((btn) => btn.onclick = () => { openModal("Founder decision", `<label class="field-label">Direction for the team</label><textarea class="editor" id="decision-direction" placeholder="Approve the recommended option because…"></textarea><button class="btn" id="submit-decision">Send decision & resume</button>`); document.getElementById("submit-decision").onclick = async () => { try { await apiJson("/api/founder/decisions/resolve", { method: "POST", body: JSON.stringify({ statePath: btn.dataset.resolveDecision, direction: document.getElementById("decision-direction").value }) }); closeModal(); showToast("Decision recorded. Work resumed."); route(); } catch (e) { showToast(e.message, true); } }; });
    app.querySelectorAll("[data-approve-decision]").forEach((btn) => btn.onclick = () => { openModal("Signed founder approval", `<p class="muted small">Create the assertion with <code>factory-sign-approval.mjs</code>, then submit its path and the matching evidence path inside the task worktree.</p><label class="field-label">Approval assertion path</label><input class="modal-input" id="approval-assertion" placeholder="/private/operator/approval.json"/><label class="field-label">Evidence path (relative to worktree)</label><input class="modal-input" id="approval-evidence" placeholder="evidence/founder-approval.md"/><button class="btn" id="submit-approval">Verify & approve</button>`); document.getElementById("submit-approval").onclick = async () => { try { await apiJson("/api/founder/decisions/approve", { method: "POST", body: JSON.stringify({ statePath: btn.dataset.approveDecision, approvalAssertionPath: document.getElementById("approval-assertion").value, evidence: document.getElementById("approval-evidence").value }) }); closeModal(); showToast("Signature verified. Work resumed."); route(); } catch (e) { showToast(e.message, true); } }; });
    document.getElementById("ask-agent").onclick = () => { openModal("Ask an agent", `<label class="field-label">Agent</label><input class="modal-input" id="question-agent" value="main"/><label class="field-label">Question</label><textarea class="editor" id="question-text" placeholder="What is blocking this project?"></textarea><button class="btn" id="send-question">Ask</button><div id="question-answer"></div>`); document.getElementById("send-question").onclick = async () => { const out = document.getElementById("question-answer"); out.innerHTML = `<p class="muted">Agent is thinking…</p>`; try { const j = await apiJson("/api/founder/questions", { method: "POST", body: JSON.stringify({ agentId: document.getElementById("question-agent").value, question: document.getElementById("question-text").value }) }); out.innerHTML = `<div class="card">${esc(j.question.answer)}</div>`; } catch (e) { out.innerHTML = `<p class="danger-text">${esc(e.message)}</p>`; } }; };
    document.getElementById("new-project").onclick = () => { openModal("Create project", `<label class="field-label">Name</label><input class="modal-input" id="project-name"/><label class="field-label">ID</label><input class="modal-input" id="project-id" placeholder="project-name"/><label class="field-label">Mission</label><textarea class="editor" id="project-mission"></textarea><label class="field-label">Repository path (optional)</label><input class="modal-input" id="project-repo"/><button class="btn" id="create-project">Create project</button>`); document.getElementById("create-project").onclick = async () => { try { await apiJson("/api/founder/projects", { method: "POST", body: JSON.stringify({ name: document.getElementById("project-name").value, id: document.getElementById("project-id").value, mission: document.getElementById("project-mission").value, repoPath: document.getElementById("project-repo").value }) }); closeModal(); showToast("Project created."); route(); } catch (e) { showToast(e.message, true); } }; };
  }

  function renderAgentRail(agents) {
    const active = agents.filter((a) => a.layer !== "existing-agent").slice(0, 12);
    return `
      <aside class="agent-rail">
        <div class="rail-title">HQ Team</div>
        <input class="rail-filter" placeholder="Filter agents..." disabled />
        ${active.map((a) => `
          <div class="rail-agent">
            <div class="avatar">${esc((a.name || "?").slice(0, 2))}</div>
            <div>
              <strong>${esc(a.name)}</strong>
              <span>${esc(a.role)}</span>
              <em>${esc(a.lifecycleStatus || a.status)}</em>
            </div>
          </div>`).join("")}
      </aside>`;
  }

  async function renderAgents() {
    const d = await loadHq();
    const global = d.agents.filter((a) => a.layer === "global-hq");
    const ceos = d.agents.filter((a) => a.layer === "project-ceo");
    const existing = d.agents.filter((a) => a.layer === "existing-agent");
    app.innerHTML = `
      <h1 class="page-title">Agents</h1>
      <p class="muted">Two-layer command structure plus existing integrated agents.</p>
      ${agentGroup("Global HQ", global, d)}
      ${agentGroup("Project CEOs", ceos, d)}
      ${agentGroup("Existing Integrated Agents", existing, d)}`;
    app.querySelectorAll("[data-run-existing]").forEach((btn) => {
      btn.onclick = () => {
        const [project, id] = btn.dataset.runExisting.split("/");
        runAgent(project, id, false);
      };
    });
  }

  function agentGroup(title, list, d) {
    return `
      <h2 class="section-title">${esc(title)}</h2>
      <div class="agent-grid">
        ${list.map((a) => `
          <article class="agent-card">
            <div class="agent-card-head">
              <div class="avatar large">${esc((a.name || "?").slice(0, 2))}</div>
              <div>
                <h3>${esc(a.name)}</h3>
                <p>${esc(a.role)}</p>
              </div>
              ${pill(a.lifecycleStatus || a.status, a.executable ? "health-healthy" : "badge-type")}
            </div>
            <dl class="meta-grid">
              <dt>Division</dt><dd>${esc(a.division || "-")}</dd>
              <dt>Kind</dt><dd>${esc(a.agentKind === "executable-agent" ? "Executable agent" : "Conceptual persona")}</dd>
              <dt>Promotion</dt><dd>${esc(promotionText(a))}</dd>
              <dt>Reports to</dt><dd>${esc(agentName(d.agents, a.reportsTo))}</dd>
              <dt>Manages</dt><dd>${esc((a.manages || []).map((id) => agentName(d.agents, id)).join(", ") || "-")}</dd>
              <dt>Current task</dt><dd>${esc(a.currentTask || "-")}</dd>
              <dt>Last output</dt><dd>${esc(a.lastOutput || "-")}</dd>
            </dl>
            <div class="permission-row">${(a.approvalPermissions || []).map((p) => pill(p, "badge-type")).join("")}</div>
            ${a.executable && a.realAgentKey ? `<div class="row-actions">
              <button class="btn" data-run-existing="${esc(a.realAgentKey)}">Run now</button>
              <a class="btn secondary" href="#/agent/${encodeURIComponent(a.realAgentKey.split("/")[0])}/${encodeURIComponent(a.realAgentKey.split("/")[1])}">Open lab agent</a>
            </div>` : ""}
          </article>`).join("")}
      </div>`;
  }

  function promotionText(agent) {
    if (agent.executable) return `runnable: ${agent.realAgentKey}`;
    const p = agent.promotion || {};
    if (!p.candidateKey) return "persona only";
    if (!p.folderExists) return `missing folder: ${p.candidateKey}`;
    if (!p.runnableFolder) return `missing ${Array.isArray(p.missing) ? p.missing.join(", ") : "required files"}`;
    if (!p.registered) return "folder ready, not registered";
    return "not runnable";
  }

  async function renderProjects() {
    const d = await loadHq();

    // Pre-compute per-project stats from the already-loaded HQ data
    function projectStats(projectId) {
      const agents = (d.agents || []).filter((a) => a.projectId === projectId);
      const real = agents.filter((a) => a.executable).length;
      const conceptual = agents.filter((a) => !a.executable).length;
      const tasks = (d.tasks || []).filter((t) => t.projectId === projectId);
      const active = tasks.filter((t) => !["Done", "Blocked"].includes(t.status)).length;
      const blocked = tasks.filter((t) => t.status === "Blocked").length;
      const needsJ = tasks.filter((t) => t.approvalRequired && t.status !== "Done").length;
      return { real, conceptual, active, blocked, needsJ };
    }

    app.innerHTML = `
      <div class="page-head">
        <div>
          <h1 class="page-title">Projects</h1>
          <p class="muted">Click any project to open its full profile, org structure, agent cards, workflows, and tasks.</p>
        </div>
      </div>
      <div class="project-grid">
        ${d.projects.map((p) => {
          const href = `#/project/${encodeURIComponent(p.id)}`;
          const s = projectStats(p.id);
          const ceoAgent = (d.agents || []).find((a) => a.id === p.projectCEO);
          const ceoName = ceoAgent ? ceoAgent.name : (p.projectCEO || "-");
          return `
          <article class="project-card project-card-link" data-href="${esc(href)}">
            <div class="card-head">
              <div style="min-width:0">
                <h3 class="card-title">${esc(p.name)}</h3>
                <div class="card-meta">${esc(p.currentPhase || "active")} · CEO: <strong>${esc(ceoName)}</strong></div>
              </div>
              <a class="btn" href="${esc(href)}">Open →</a>
            </div>
            <p style="margin:0.6rem 0 0.75rem">${esc(p.mission || p.description || "")}</p>
            <div class="proj-stats-row">
              <span class="proj-stat ${s.real > 0 ? "proj-stat-green" : ""}">
                ${s.real} real agent${s.real !== 1 ? "s" : ""}
              </span>
              <span class="proj-stat proj-stat-muted">
                ${s.conceptual} conceptual
              </span>
              ${s.active > 0 ? `<span class="proj-stat">${s.active} active task${s.active !== 1 ? "s" : ""}</span>` : ""}
              ${s.blocked > 0 ? `<span class="proj-stat proj-stat-red">${s.blocked} blocked</span>` : ""}
              ${s.needsJ > 0 ? `<span class="proj-stat proj-stat-amber">${s.needsJ} needs Operator</span>` : ""}
            </div>
            ${p.bottleneck ? `<div class="proj-bottleneck muted small">Bottleneck: ${esc(p.bottleneck)}</div>` : ""}
          </article>`;
        }).join("")}
      </div>`;

    // Make entire card clickable
    app.querySelectorAll(".project-card-link").forEach((card) => {
      card.onclick = (e) => {
        if (e.target.closest("a, button")) return;
        location.hash = card.dataset.href.replace(/^#/, "");
      };
    });
  }

  // ── Project profile helpers ────────────────────────────────────

  function agentKindBadge(agent) {
    if (agent.executable) return pill("real executable", "badge-executable");
    return pill("conceptual", "badge-conceptual");
  }

  function lifecycleBadge(agent) {
    const s = String(agent.lifecycleStatus || agent.status || "unknown");
    const cls =
      s === "active" || s === "scheduled"
        ? "health-healthy"
        : s === "failed"
          ? "health-failed"
          : "badge-lifecycle";
    return pill(s, cls);
  }

  function renderAgentRoleCard(agent) {
    const key = agent.realAgentKey || "";
    const parts = key.split("/");
    const proj = parts[0] || "";
    const aid = parts[1] || "";
    const lr = agent.labAgent ? agent.labAgent.lastRun : null;
    const lrStatus = lr ? lr.status : null;
    const lrTime = lr ? fmtTime(lr.ended_at || lr.started_at) : null;
    const lrArtifact = lr ? lr.artifactsPreview : null;
    const execClass = agent.executable ? "is-executable" : "is-conceptual";

    return `
      <div class="agent-role-card ${execClass}">
        <div class="arc-name">${esc(agent.name)}</div>
        <div class="arc-role">${esc(agent.role)}</div>
        <div class="arc-badges">
          ${agentKindBadge(agent)}
          ${lifecycleBadge(agent)}
        </div>
        ${agent.description ? `<div class="arc-detail">${esc(agent.description)}</div>` : ""}
        ${agent.currentTask ? `<div class="arc-detail muted">${esc(agent.currentTask)}</div>` : ""}
        ${agent.executable
          ? `<div class="arc-run-info">
              Last run: ${lrStatus
                ? pill(lrStatus, lrStatus === "success" ? "health-healthy" : "health-failed") + " " + esc(lrTime || "")
                : "<span class='muted'>No runs yet</span>"}
              ${lrArtifact ? `<br>${esc(lrArtifact)}` : ""}
            </div>
            <div class="arc-actions">
              <button class="btn arc-run-btn" data-agent-key="${esc(key)}">Run now</button>
              <a class="btn secondary" href="#/agent/${encodeURIComponent(proj)}/${encodeURIComponent(aid)}">Runs / logs</a>
              <button class="btn ghost arc-logs-btn" data-agent-key="${esc(key)}">Logs</button>
              <button class="btn ghost arc-cfg-btn" data-agent-key="${esc(key)}">Config</button>
            </div>`
          : `<div class="arc-run-info muted">Not executable — persona only, no folder</div>`}
      </div>`;
  }

  function buildOrgTree(ceo, agents) {
    if (!ceo) return `<p class="muted small">No CEO defined for this project.</p>`;
    const workers = [...(agents.realWorkers || []), ...(agents.conceptualWorkers || [])];
    const lines = [];

    lines.push(`<div class="ot-root">Operator</div>`);

    const ceoExec = ceo.executable;
    lines.push(
      `<div class="ot-line"><span class="ot-prefix">└── </span><span class="${ceoExec ? "ot-exec" : "ot-concept"}">${esc(ceo.name)}</span>` +
      ` <span class="ot-meta">${esc(ceo.role)} · ${ceoExec ? "● real executable" : "○ conceptual"}</span></div>`
    );

    workers.forEach((w, i) => {
      const last = i === workers.length - 1;
      const pfx = last ? "    └── " : "    ├── ";
      const pipe = last ? "        " : "    │   ";
      const wExec = w.executable;
      lines.push(
        `<div class="ot-line"><span class="ot-prefix">${pfx}</span><span class="${wExec ? "ot-exec" : "ot-concept"}">${esc(w.name)}</span>` +
        ` <span class="ot-meta">${esc(w.role)} · ${wExec ? "● real executable" : "○ conceptual"}</span></div>`
      );
      if (wExec && w.labAgent) {
        const tools = (w.labAgent.config && w.labAgent.config.tools
          ? w.labAgent.config.tools
          : []
        ).slice(0, 4);
        tools.forEach((t, ti) => {
          const tlast = ti === tools.length - 1;
          lines.push(
            `<div class="ot-line ot-leaf"><span class="ot-prefix">${pipe}${tlast ? "└── " : "├── "}</span><span class="ot-tool">${esc(t)}</span></div>`
          );
        });
      }
    });

    return `<div class="org-tree">${lines.join("")}</div>`;
  }

  function renderWorkflowSection(project) {
    const steps = Array.isArray(project.mainWorkflows) ? project.mainWorkflows : [];
    if (!steps.length) return "";
    return `
      <section class="profile-section">
        <h2 class="section-title">How Work Flows</h2>
        <div class="workflow-steps">
          ${steps.map((step, i) => `
            <div class="workflow-step">
              <div class="step-num">${i + 1}</div>
              <div class="step-text">${esc(step)}</div>
            </div>`).join("")}
        </div>
      </section>`;
  }

  function renderApprovalSection(project) {
    const rules = Array.isArray(project.approvalRules) ? project.approvalRules : [];
    if (!rules.length) return "";
    return `
      <section class="profile-section">
        <h2 class="section-title">Decision Rights</h2>
        <div class="approval-list">
          ${rules.map((rule) => {
            const text = String(rule);
            const isNo = /cannot|must not|without approval|never|blocked|do not/i.test(text);
            return `
              <div class="approval-item">
                <span class="ai-prefix ${isNo ? "ai-cannot" : "ai-can"}">${isNo ? "cannot" : "can"}</span>
                <span>${esc(text)}</span>
              </div>`;
          }).join("")}
        </div>
      </section>`;
  }

  function renderProjectTaskMinis(tasks) {
    const seen = new Set();
    const all = [
      ...(tasks.needsJoao || []),
      ...(tasks.blocked || []),
      ...(tasks.active || []),
    ].filter((t) => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });
    if (!all.length) return `<p class="muted small">No active tasks.</p>`;
    return all.slice(0, 6).map((t) => {
      const isBlocked = t.status === "Blocked";
      const needsJ = t.approvalRequired && t.status !== "Done";
      const pCls = String(t.priority || "low").toLowerCase();
      return `
        <div class="task-mini priority-${esc(pCls)} ${isBlocked ? "task-mini-blocked" : ""}">
          <div class="tm-title">${esc(t.title)}</div>
          <div class="tm-meta">
            ${pill(t.status || "?", isBlocked ? "health-failed" : needsJ ? "badge-warn" : "badge-type")}
            ${needsJ ? pill("Needs Operator", "badge-warn") : ""}
          </div>
          ${isBlocked && t.blocker ? `<div class="tm-blocker">${esc(String(t.blocker).slice(0, 120))}</div>` : ""}
        </div>`;
    }).join("");
  }

  function renderProjectActivity(runs, reports) {
    const items = [];
    for (const r of (runs || []).slice(0, 5)) {
      items.push({
        dot: r.status,
        label: r.agentId || r.agent_key,
        badge: r.status,
        badgeCls: r.status === "success" ? "health-healthy" : r.status === "failed" ? "health-failed" : "badge-type",
        detail: r.artifactsPreview || r.summary || r.error_message || "",
        time: r.ended_at || r.started_at,
        link: `#/run/${r.id}`,
        linkLabel: "View run →",
      });
    }
    for (const r of (reports || []).slice(0, 3)) {
      items.push({
        dot: "info",
        label: r.title,
        badge: "report",
        badgeCls: "badge-type",
        detail: r.summary || "",
        time: r.createdAt,
        link: "#/reports",
        linkLabel: "Reports →",
      });
    }
    if (!items.length) return `<p class="muted small">No recent activity.</p>`;
    return items.map((item) => `
      <div class="activity-item">
        <div class="activity-dot ${item.dot === "success" ? "success" : item.dot === "failed" ? "failed" : ""}"></div>
        <div class="activity-content">
          <strong>${esc(item.label)}</strong> ${pill(item.badge, item.badgeCls)}
          ${item.detail ? `<br>${esc(String(item.detail).slice(0, 80))}` : ""}
          <br><span class="activity-time">${esc(fmtTime(item.time))}</span>
          ${item.link ? ` · <a href="${esc(item.link)}">${esc(item.linkLabel)}</a>` : ""}
        </div>
      </div>`).join("");
  }

  function openProjectJsonModal(id, currentProject) {
    openModal(`Edit project JSON: ${id}`, `
      <p class="muted" style="font-size:0.82rem">Editing <code>dashboard/backend/data/hq/projects/${esc(id)}.json</code>. This updates the data file only.</p>
      <textarea class="editor tall" id="project-modal-editor">${esc(JSON.stringify(currentProject, null, 2))}</textarea>
      <div class="row-actions">
        <button class="btn" id="save-project-modal">Save profile</button>
      </div>`);
    document.getElementById("save-project-modal").onclick = async () => {
      try {
        const project = JSON.parse(document.getElementById("project-modal-editor").value);
        await apiJson(`/api/hq/projects/${encodeURIComponent(id)}`, {
          method: "PUT",
          body: JSON.stringify({ project }),
        });
        closeModal();
        showToast("Project profile saved.");
        renderProject({ name: "project", id });
      } catch (e) {
        showToast(String(e.message || e), true);
      }
    };
  }

  async function renderProject(route) {
    let d;
    try {
      d = await apiJson(`/api/hq/projects/${encodeURIComponent(route.id)}/profile`);
    } catch (e) {
      app.innerHTML = `<p class="muted">Error loading profile: ${esc(String(e.message || e))}</p>`;
      return;
    }

    const { project: p, ceo, agents, tasks, recentRuns, recentReports, stats } = d;

    app.innerHTML = `
      <div class="profile-back"><a href="#/projects">← Projects</a></div>

      <div class="page-head" style="margin-top:0.5rem">
        <div>
          <h1 class="page-title">${esc(p.name)}</h1>
          <div class="profile-meta">
            ${pill(p.id, "badge-type")}
            ${pill(p.currentPhase || "active", "badge-type")}
            ${ceo ? `CEO: <strong>${esc(ceo.name)}</strong>` : ""}
          </div>
        </div>
        <button class="btn secondary" id="profile-edit-json">Edit raw JSON</button>
      </div>

      <div class="profile-stats">
        <div class="pstat"><div class="pstat-val">${stats.activeTasks}</div><div class="pstat-label">Active Tasks</div></div>
        <div class="pstat ${stats.blockedTasks > 0 ? "pstat-warn" : ""}"><div class="pstat-val">${stats.blockedTasks}</div><div class="pstat-label">Blocked</div></div>
        <div class="pstat ${stats.needsJoao > 0 ? "pstat-action" : ""}"><div class="pstat-val">${stats.needsJoao}</div><div class="pstat-label">Needs Operator</div></div>
        <div class="pstat"><div class="pstat-val">${stats.realAgents}</div><div class="pstat-label">Real Agents</div></div>
        <div class="pstat pstat-muted"><div class="pstat-val">${stats.conceptualAgents}</div><div class="pstat-label">Conceptual</div></div>
      </div>

      <div class="profile-grid">
        <div class="profile-main">

          <section class="profile-section">
            <h2 class="section-title">Overview</h2>
            <p>${esc(p.mission || p.description || "")}</p>
            <dl class="meta-grid compact">
              <dt>Phase</dt><dd>${esc(p.currentPhase || "-")}</dd>
              <dt>Status</dt><dd>${esc(p.currentStatus || "-")}</dd>
              <dt>Metric</dt><dd>${esc(p.mainMetric || "-")}</dd>
              <dt>Bottleneck</dt><dd>${esc(p.bottleneck || "-")}</dd>
              ${p.latestReport ? `<dt>Latest report</dt><dd>${esc(p.latestReport)}</dd>` : ""}
            </dl>
            ${(p.nextRecommendedActions || []).length
              ? `<div class="profile-next-action"><strong>Next:</strong> ${esc(p.nextRecommendedActions[0])}</div>`
              : ""}
          </section>

          <section class="profile-section">
            <h2 class="section-title">Operating Structure</h2>

            ${ceo ? `
            <div class="work-structure">
              <div class="structure-group">
                <div class="structure-label">CEO / Owner</div>
                <div class="role-cards-row">${renderAgentRoleCard(ceo)}</div>
              </div>
              <div class="structure-group">
                <div class="structure-label">Reports to</div>
                <div class="structure-chain">${esc(ceo.reportsTo || "jarvis")} → Operator</div>
              </div>
            </div>` : ""}

            ${agents.sharedSupport.length ? `
            <div class="structure-group">
              <div class="structure-label">Shared Support (Global HQ)</div>
              <div class="role-cards-row">${agents.sharedSupport.map((a) => renderAgentRoleCard(a)).join("")}</div>
            </div>` : ""}

            ${agents.realWorkers.length ? `
            <div class="structure-group">
              <div class="structure-label">Real Executable Agents</div>
              <div class="role-cards-row">${agents.realWorkers.map((a) => renderAgentRoleCard(a)).join("")}</div>
            </div>` : `<p class="muted small">No real executable agents yet.</p>`}

            ${agents.conceptualWorkers.length ? `
            <div class="structure-group">
              <div class="structure-label">Conceptual / Planned</div>
              <div class="role-cards-row">${agents.conceptualWorkers.map((a) => renderAgentRoleCard(a)).join("")}</div>
            </div>` : ""}
          </section>

          <section class="profile-section">
            <h2 class="section-title">Org Tree</h2>
            ${buildOrgTree(ceo, agents)}
          </section>

          ${renderWorkflowSection(p)}
          ${renderApprovalSection(p)}

        </div>

        <div class="profile-sidebar">

          <div class="sidebar-card">
            <h2 class="section-title">Tasks &amp; Blockers</h2>
            ${renderProjectTaskMinis(tasks)}
            <a class="btn secondary" style="display:block;text-align:center;margin-top:0.65rem" href="#/tasks">All Tasks →</a>
          </div>

          <div class="sidebar-card">
            <h2 class="section-title">Recent Activity</h2>
            ${renderProjectActivity(recentRuns, recentReports)}
            ${recentRuns.length
              ? `<a class="btn secondary" style="display:block;text-align:center;margin-top:0.65rem" href="#/runs">All Runs →</a>`
              : ""}
          </div>

          ${(p.currentBlockers || []).length ? `
          <div class="sidebar-card">
            <h2 class="section-title">Current Blockers</h2>
            ${p.currentBlockers.map((b) => `<div class="feed-item danger"><p>${esc(b)}</p></div>`).join("")}
          </div>` : ""}

          ${recentReports.length ? `
          <div class="sidebar-card">
            <h2 class="section-title">Latest Reports</h2>
            ${recentReports.map((r) => `
              <div class="feed-item">
                <strong>${esc(r.title)}</strong>
                <div class="muted small">${esc(fmtTime(r.createdAt))}</div>
                <p>${esc(r.summary || "")}</p>
              </div>`).join("")}
            <a class="btn secondary" style="display:block;text-align:center;margin-top:0.5rem" href="#/reports">All Reports →</a>
          </div>` : ""}

        </div>
      </div>`;

    document.getElementById("profile-edit-json").onclick = () => openProjectJsonModal(route.id, p);

    app.querySelectorAll(".arc-run-btn").forEach((btn) => {
      const [proj, aid] = (btn.dataset.agentKey || "").split("/");
      if (proj && aid) btn.onclick = () => runAgent(proj, aid, false);
    });

    app.querySelectorAll(".arc-logs-btn").forEach((btn) => {
      const [proj, aid] = (btn.dataset.agentKey || "").split("/");
      if (proj && aid) {
        btn.onclick = async () => {
          try {
            const r = await api(
              `/api/agents/${encodeURIComponent(proj)}/${encodeURIComponent(aid)}/logs?lines=60`
            );
            openModal(`Logs: ${proj}/${aid}`, `<pre class="code">${esc(await r.text())}</pre>`);
          } catch (e) {
            showToast(String(e.message || e), true);
          }
        };
      }
    });

    app.querySelectorAll(".arc-cfg-btn").forEach((btn) => {
      const [proj, aid] = (btn.dataset.agentKey || "").split("/");
      if (proj && aid) {
        btn.onclick = async () => {
          try {
            const r = await api(
              `/api/agents/${encodeURIComponent(proj)}/${encodeURIComponent(aid)}/workspace/agent.config.json`
            );
            openModal(
              `Config: ${proj}/${aid}`,
              `<pre class="code">${esc(await r.text())}</pre>`
            );
          } catch (e) {
            showToast(String(e.message || e), true);
          }
        };
      }
    });
  }

  async function renderTasks() {
    const d = await loadHq();
    app.innerHTML = `
      <div class="page-head">
        <div>
          <h1 class="page-title">Task Board</h1>
          <p class="muted">Inbox, Assigned, In Progress, Review, Done, and Blocked across the whole HQ.</p>
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
      <div class="page-head">
        <div><h1 class="page-title">SOPs</h1><p class="muted">Global and project-specific operating procedures.</p></div>
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
        ${logSection("Daily / Decision / Task Logs", d.logs, d)}
        ${logSection("Agent Run Logs", (runRows.runs || []).map((r) => ({
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
      <div class="page-head">
        <div><h1 class="page-title">Reports</h1><p class="muted">Charles daily brief, project CEO reports, and weekly reviews.</p></div>
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

  async function renderRuns() {
    const d = await apiJson("/api/runs?limit=80");
    app.innerHTML = `
      <h1 class="page-title">Runs</h1>
      <p class="muted">Existing Agent Lab run history is preserved here.</p>
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
