import * as objectiveRecovery from "/lib/objectiveRecovery.mjs";
import * as founderApproval from "/lib/founderApproval.mjs";
import * as objectiveView from "/lib/objectiveView.mjs";
import { costLimitsPanel } from "/cost-limits.mjs";

(function () {
  const app = document.getElementById("app");
  const nav = document.getElementById("nav");
  const toastEl = document.getElementById("toast");
  const modal = document.getElementById("modal");
  const modalTitle = document.getElementById("modal-title");
  const modalBody = document.getElementById("modal-body");

  const BOARD_COLUMNS = ["Inbox", "Assigned", "In Progress", "Review", "Done", "Blocked"];
  const SEVERITY_RANK = { high: 0, medium: 1, low: 2, unspecified: 3 };

  // Objectives from the last Today render, keyed by objectiveId, so the
  // "Details" drill-down can render without another round-trip.
  let objectivesById = {};
  let executionPoll = null;

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
    if (executionPoll) { clearInterval(executionPoll); executionPoll = null; }
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

  // Compact wall-clock duration: "3h 12m", "8m", "45s". Input is milliseconds.
  function fmtDuration(ms) {
    if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}m`;
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
  }

  function fmtLastResult(r) {
    if (!r || !r.stage) return "—";
    const verdict = r.outcome === "pass" ? "passed" : r.outcome === "fail" ? "failed" : r.outcome || "—";
    return `${r.stage} ${verdict}${r.summary ? ` — ${r.summary}` : ""}`;
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
    const [state, fc, learning, objectivesResp, autonomy, costs, planLimits] = await Promise.all([
      loadCompany(),
      apiJson("/api/founder/overview").catch(() => ({ jobs: [] })),
      loadLearning().catch(() => null),
      apiJson("/api/founder/objectives").catch(() => ({ objectives: [], summary: {} })),
      apiJson("/api/hq/autonomy").catch(() => null),
      apiJson("/api/hq/costs").catch(() => null),
      apiJson("/api/hq/plan-limits").catch(() => null),
    ]);
    const objectives = objectivesResp.objectives || [];
    objectivesById = Object.fromEntries(objectives.map((o) => [o.objectiveId, o]));
    const projects = state.projects || [];
    const agents = state.agents?.agents || [];
    const decisions = state.decisions || [];
    const inbox = fc.inbox || [];
    const dismissedInbox = fc.dismissedInbox || [];
    const inboxActionable = inbox.filter((i) => i.action && i.action !== "none").length;
    const jobs = fc.jobs || [];
    const allTasks = fc.tasks || [];
    const autoRecovering = fc.autoRecovering || [];
    const finishedTasks = allTasks.filter((t) => t.completionReport || t.status === "merge-ready" || t.status === "merged");
    const runningRows = buildRunningNow(objectives, allTasks, agents);
    // Founder jobs that are live (not yet decomposed into visible nodes) — the
    // "your request was received, agents are on it" confirmation.
    const liveJobs = jobs.filter((j) => j.status === "starting" || j.status === "running" || j.status === "decomposing");

    app.innerHTML = `
      <section class="hq-layout">
        ${renderAgentRail(agents, state.runtime)}
        <main class="hq-main">
          <div class="founder-hero">
            <div class="eyebrow">${esc(state.founder?.headquarters || "Headquarters")}</div>
            <h1>What should the company build next?</h1>
            <p>Give your team an outcome. OpenClaw will turn it into bounded work and route the right agents.</p>
            <form id="founder-command" class="founder-command">
              <textarea id="founder-objective" rows="2" placeholder="Build the onboarding system for LifeMaxing" required></textarea>
              <div class="founder-command-row">
                <select id="founder-project" required>
                  <option value="">Choose project</option>
                  ${projects.map((p) => `<option value="${esc(p.key)}" data-repo="${esc(p.repo || "")}">${esc(p.name)}</option>`).join("")}
                  ${state.headquarters ? `<option value="${esc(state.headquarters.key)}" data-repo="${esc(state.headquarters.repo || "")}">${esc(state.headquarters.name)} (infrastructure)</option>` : ""}
                </select>
                <input id="founder-repo" placeholder="Repository path (auto for registered projects)" />
                <button class="btn founder-launch" type="submit">Start work →</button>
              </div>
              <label class="founder-decompose"><input type="checkbox" id="founder-decompose" /> Decompose into a dependency-aware graph and run independent parts in parallel</label>
              <div id="founder-self-note" class="founder-self-note" hidden>Runs the factory on its own codebase — same worktrees, review, QA, security, and evidence. Delivered as a PR you review; never pushed to <code>main</code>.</div>
              <div class="founder-presets">
                <span class="muted small">Run on the factory itself:</span>
                <button type="button" class="chip" data-preset="Improve Headquarters observability: make it easier for the founder to see what each agent is doing, what it produced, and what needs a decision.">Improve HQ observability</button>
                <button type="button" class="chip" data-preset="Review how the factory has been operating, find the single biggest bottleneck in the objective/orchestration path, and fix it.">Find &amp; fix the biggest bottleneck</button>
                <button type="button" class="chip" data-preset="Make the Headquarters dashboard easier for a founder to understand at a glance, without adding new systems.">Make the dashboard clearer</button>
              </div>
            </form>
          </div>

          ${runtimeBanner(state.runtime)}

          <div class="control-stats">
            <div><strong>${projects.length}</strong><span>Projects</span></div>
            <div><strong>${state.summary.workingAgents}</strong><span>Agents working</span></div>
            <div class="${inboxActionable ? "attention" : ""}"><strong>${inboxActionable}</strong><span>Need your input</span></div>
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
              <div class="panel-heading"><div><span class="eyebrow">Founder inbox</span><h2>Needs you</h2></div>${inboxActionable ? pill(inboxActionable, "badge-warn") : pill("Clear", "health-healthy")}</div>
              ${inbox.map((x) => inboxItem(x)).join("") || `<div class="empty-state"><strong>Nothing needs you.</strong><span>Your agents have what they need to keep moving.</span></div>`}
              ${dismissedInbox.length ? `<details class="inbox-fold">
                <summary><span class="eyebrow">Dismissed</span> Hidden by you — still open, fully restorable <span class="muted small">${dismissedInbox.length}</span></summary>
                <div class="inbox-fold-list">${dismissedInbox.map((x) => dismissedInboxRow(x)).join("")}</div>
              </details>` : ""}
              ${recommendedActions(state.company)}
            </section>
          </div>

          ${renderObjectivePortfolio(objectives)}

          <section class="activity-panel">
            <div class="panel-heading"><div><span class="eyebrow">Delivered</span><h2>Completed tasks</h2></div>${finishedTasks.length ? pill(finishedTasks.length, "health-healthy") : ""}</div>
            <div class="company-feed">
              ${finishedTasks.map((t) => `
                <div class="company-agent">
                  <span class="activity-pulse"></span>
                  <div><strong>${esc(t.objective || t.id)}</strong>
                    <small class="muted">${esc(t.project || "—")} · ${esc(t.status)}${t.elapsedMs != null ? ` · ${esc(fmtDuration(t.elapsedMs))}` : ""} · <code>${esc(t.id)}</code></small>
                  </div>
                  <button class="btn secondary" data-report-task="${esc(t.id)}">View report</button>
                </div>`).join("") || `<div class="empty-state">No task has finished in this environment yet.</div>`}
            </div>
          </section>

          <section class="activity-panel">
            <div class="panel-heading"><div><span class="eyebrow">Live</span><h2>Running now</h2></div><button class="btn secondary" id="ask-agent">Ask an agent</button></div>
            ${liveJobs.map((j) => founderAckRow(j)).join("")}
            ${autoRecovering.map((r) => autoRecoverRow(r)).join("")}
            ${runningRows.length ? runningRows.map((r) => runningNowRow(r)).join("") : (liveJobs.length || autoRecovering.length ? "" : `<div class="empty-state">Nothing is executing right now. Give the factory an objective above, or check "Autonomy" below for what runs on a schedule.</div>`)}
          </section>

          <section class="activity-panel">
            <div class="panel-heading"><div><span class="eyebrow">Machine events</span><h2>Recent activity</h2></div><span class="muted small">raw workflow events</span></div>
            <div class="company-feed">
              ${(state.activityFeed || []).slice(0, 10).map((e) => `<div class="company-event"><span>${esc(String(e.type || "event").replaceAll("-", " "))}</span><strong>${esc(e.taskId)}</strong>${e.stage ? ` <span class="muted small">${esc(e.stage)}</span>` : ""}<time>${esc(fmtTime(e.at))}</time></div>`).join("") || `<div class="empty-state">No factory task has run in this environment yet.</div>`}
            </div>
          </section>

          ${costLimitsPanel(costs, planLimits)}
          ${autonomySection(autonomy)}
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

  const PIPELINE = ["product", "architect", "builder", "reviewer", "qa", "security", "release"];

  // "Running now" — one row per unit of work actually executing or blocked, keyed
  // to stage / who / last output / next / blocker. Real fields only.
  function buildRunningNow(objectives, tasks, agents) {
    const agentById = byId(agents);
    const rows = [];
    const objTaskIds = new Set();
    for (const o of objectives) {
      for (const n of [...(o.nodes || []), o.integration].filter(Boolean)) objTaskIds.add(n.id);
      if (o.status !== "active") continue;
      for (const n of [...(o.nodes || []), o.integration].filter(Boolean)) {
        if (!["running", "blocked", "blocked-by-dep"].includes(n.status)) continue;
        rows.push({
          kind: "objective-node",
          objectiveId: o.objectiveId,
          title: n.title || n.id.replace(`${o.objectiveId}-`, "").replace(/-/g, " "),
          sub: `part of: ${String(o.objective).slice(0, 60)}${o.objective.length > 60 ? "…" : ""}`,
          role: n.role, agent: n.role, model: n.model, stage: n.stage, status: n.status,
          elapsedMs: n.elapsedMs, lastResult: n.lastResult, blocker: n.blocker,
          next: n.status === "running" && n.stage ? nextStage(n.stage) : null,
          reportId: n.hasReport ? n.id : null,
        });
      }
    }
    const STALE_ACTIVE_MS = 90 * 60 * 1000;
    for (const t of tasks) {
      if (objTaskIds.has(t.id)) continue;
      if (t.status !== "active" && t.status !== "blocked") continue;
      // Infra-blocked and restart-orphaned tasks are shown in the "recovering"
      // strip, not here.
      if (t.status === "blocked" && t.blockerClass === "infra") continue;
      if (t.status === "active" && Date.now() - (Date.parse(t.updatedAt) || Date.now()) > STALE_ACTIVE_MS) continue;
      const a = agentById[t.agent] || Object.values(agentById).find((x) => x.runtimeAgentId === t.agent);
      rows.push({
        kind: "task", taskId: t.id, title: t.objective || t.id, sub: t.project || t.id,
        role: t.agent, agent: a?.name || t.agent, stage: t.stage, status: t.status,
        elapsedMs: t.elapsedMs, lastResult: t.lastResult, blocker: t.blocker,
        next: t.status === "active" && t.stage ? nextStage(t.stage) : null,
        reportId: t.completionReport ? t.id : null,
      });
    }
    return rows;
  }

  function nextStage(stage) {
    const i = PIPELINE.indexOf(stage);
    return i >= 0 && i < PIPELINE.length - 1 ? PIPELINE[i + 1] : (i === PIPELINE.length - 1 ? "merge-ready" : null);
  }

  function runningNowRow(r) {
    const stageNum = PIPELINE.indexOf(r.stage);
    const stageLabel = stageNum >= 0 ? `stage ${stageNum + 1}/7 · ${r.stage}` : (r.stage ? esc(r.stage) : "—");
    const blocked = r.status === "blocked" || r.status === "blocked-by-dep" || r.blocker;
    return `<div class="run-row ${blocked ? "run-blocked" : ""}">
      <span class="activity-pulse ${blocked ? "pulse-error" : ""}"></span>
      <div class="run-main">
        <strong>${esc(r.title)}</strong>
        <span class="muted small">${esc(r.sub)} · ${esc(r.agent || r.role || "?")}${r.model ? ` (${esc(r.model)})` : ""} · ${stageLabel}${r.elapsedMs != null ? ` · ${esc(fmtDuration(r.elapsedMs))}` : ""}</span>
        ${r.lastResult?.summary ? `<span class="run-produced">just produced: ${esc(String(r.lastResult.summary).slice(0, 160))}</span>` : ""}
        ${blocked ? `<span class="danger-text small">blocked: ${esc(r.blocker?.summary || r.blocker?.outcome || "needs attention — see Founder inbox")}</span>` : (r.next ? `<span class="muted small">next: ${esc(r.next)}</span>` : "")}
      </div>
      <div class="run-meta">${pill(r.status, blocked ? "health-failed" : "badge-type")}${r.kind === "task" ? `<button class="btn secondary tiny" data-task-execution="${esc(r.taskId)}">Details</button>` : r.kind === "objective-node" ? `<button class="btn secondary tiny" data-objective-execution="${esc(r.objectiveId)}">Details</button>` : ""}${r.reportId ? `<button class="btn secondary tiny" data-report-task="${esc(r.reportId)}">report</button>` : ""}</div>
    </div>`;
  }

  // "Your request landed and the team is on it." Shown until the work becomes
  // visible as its own run rows / objective nodes.
  function founderAckRow(j) {
    const phase = j.status === "decomposing"
      ? "Chief of Staff is breaking this into a task graph…"
      : j.status === "running"
        ? "Agents are working through it — watch the stages below."
        : "Received. Spinning up the team…";
    return `<div class="founder-ack">
      <span class="activity-pulse"></span>
      <div class="run-main">
        <strong>Your request: ${esc((j.objective || j.id || "").slice(0, 140))}</strong>
        <span class="muted small">${esc(j.projectId || "")} · ${esc(j.kind || "work")} · ${esc(phase)}</span>
      </div>
      <div class="run-meta">${pill(j.status, "badge-type")}</div>
    </div>`;
  }

  // An infra hiccup the system is recovering from on its own — informational,
  // never in the Founder Inbox. One-click "retry now" if the founder is impatient.
  function autoRecoverRow(r) {
    return `<div class="run-row run-retrying">
      <span class="activity-pulse"></span>
      <div class="run-main">
        <strong>${esc(r.objective || r.taskId)}</strong>
        <span class="muted small">${esc(r.project || "")} · ${esc(r.stage || "a stage")} hit an infrastructure hiccup · <code>${esc(r.taskId)}</code></span>
        <span class="retry-note">Recovering automatically${r.autoRetries ? ` — attempt ${r.autoRetries}` : ""}. No action needed.</span>
      </div>
      <div class="run-meta"><button class="btn secondary tiny" data-retry-task="${esc(r.taskId)}">Retry now</button></div>
    </div>`;
  }

  // Honest autonomy statement: what runs on a schedule, what's live, what's
  // configured but not actually running.
  function autonomySection(a) {
    if (!a) return "";
    const live = a.running || {};
    const sched = (a.scheduled || []).filter((s) => s.enabled);
    // collapse the per-agent "Skill collection review" fan-out
    const skillReviews = sched.filter((s) => /skill.collection.review/i.test(s.key));
    const other = sched.filter((s) => !/skill.collection.review/i.test(s.key));
    const schedLines = [
      ...other.map((s) => `<li><strong>${esc(s.displayName)}</strong> — ${esc(s.schedule)}${s.lastStatus ? ` · last ${esc(s.lastStatus)}` : ""}${s.nextRunAt ? ` · next ${esc(fmtTime(s.nextRunAt))}` : ""}</li>`),
      skillReviews.length ? `<li><strong>Skill collection review</strong> — ${esc(skillReviews[0].schedule)} · ${skillReviews.length} agents</li>` : "",
    ].filter(Boolean).join("");
    const notRunning = (a.configuredNotRunning || []).map((c) => `<li class="danger-text"><strong>${esc(c.feature)}</strong> — ${esc(c.why)}</li>`).join("");
    return `
      <section class="activity-panel">
        <div class="panel-heading"><div><span class="eyebrow">Honesty</span><h2>Autonomy</h2></div>${pill(live.anythingLive ? "active" : "idle", live.anythingLive ? "health-healthy" : "badge-type")}</div>
        <p class="small">${live.anythingLive
          ? `Working now: ${live.objectives} objective${live.objectives === 1 ? "" : "s"}, ${live.tasks} task${live.tasks === 1 ? "" : "s"}, ${live.jobs} founder job${live.jobs === 1 ? "" : "s"}.`
          : `Nothing is executing right now — the factory only acts when you give it work or a scheduled job fires.`}</p>
        <h4>Scheduled</h4>
        ${schedLines ? `<ul class="autonomy-list">${schedLines}</ul>` : `<p class="muted small">${esc(a.scheduleError || "no scheduled jobs")}</p>`}
        ${notRunning ? `<h4>Configured but NOT running</h4><ul class="autonomy-list">${notRunning}</ul>` : ""}
      </section>`;
  }
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
    // Free-text-ish placeholder options ("Provide direction", "Keep paused") are
    // not real one-click answers — only offer buttons for substantive choices.
    const choices = (x.options || []).filter((o) => !/^(provide direction|keep paused|approve and resume|submit signed approval)$/i.test(String(o).trim()));
    return `<article class="decision-card">
      <div class="decision-top"><span class="decision-icon">!</span><div><strong>${esc(x.question)}</strong><span>${esc(x.project || "company")}${x.taskId ? ` · <code>${esc(x.taskId)}</code>` : ""}</span></div></div>
      ${x.objective ? `<p class="muted small">Task: ${esc(x.objective)}</p>` : ""}
      <p>${esc(x.why || "")}</p>
      ${x.recommendation ? `<div class="decision-rec"><small>Recommendation</small>${esc(x.recommendation)}</div>` : ""}
      ${actionable
        ? `<div class="decision-choices">
            ${choices.map((c) => `<button class="btn" data-resolve-choice="${esc(x.statePath)}" data-choice="${esc(c)}">${esc(c)}</button>`).join("")}
            <button class="btn secondary" data-resolve-decision="${esc(x.statePath)}">Answer in my own words…</button>
          </div>`
        : `<p class="muted small">Strategic decision tracked in ${esc(x.project || "the project")}'s ownership.json — not resolvable from here yet; update the file directly.</p>`}
    </article>`;
  }

  // High-risk approval — one click. The signature is produced by a
  // non-extractable Ed25519 key held only in this browser (see
  // /lib/founderApproval.mjs); the server verifies + records through the
  // unchanged gate and resumes the work.
  function approvalCard(x) {
    const a = x.approval || {};
    return `<article class="decision-card approval-card" data-approval-task="${esc(x.taskId || "")}" data-approval-statepath="${esc(x.statePath || "")}">
      <div class="decision-top"><span class="decision-icon">◆</span>
        <div><strong>${esc(x.title || "Approve a high-risk build")}</strong>
        <span>${pill("Approval", "badge-warn")} ${esc(x.project || "company")}${x.taskId ? ` · <code>${esc(x.taskId)}</code>` : ""}</span></div>
      </div>
      ${x.objective ? `<p class="muted small">What the factory will do: <strong>${esc(x.objective)}</strong></p>` : ""}
      <p>${esc(x.detail || "")}</p>
      ${a.whatHappensNext ? `<div class="decision-rec"><small>After you approve</small>${esc(a.whatHappensNext)}</div>` : ""}
      <p class="muted small">${esc(a.keyNote || "Signed by a key held only in your browser.")}</p>
      <div class="approve-actions">
        <button class="btn" data-approve="${esc(x.taskId || "")}">Approve</button>
        <button class="btn secondary" data-reject="${esc(x.taskId || "")}">Reject</button>
      </div>
      <div class="approve-status" data-approve-status hidden></div>
      <details class="approve-advanced">
        <summary>Approve from a trusted terminal instead</summary>
        <p class="muted small">Run <code>npm run approve${x.taskId ? ` -- --task ${esc(x.taskId)}` : ""}</code> at the repo root. Use this if this browser can't reach your signing key.</p>
      </details>
    </article>`;
  }

  // Ensure this browser has an enrolled, non-extractable signing key. Returns a
  // CryptoKeyPair or throws with a founder-readable message.
  async function ensureApprovalKey() {
    if (!founderApproval.webcryptoEd25519Available()) {
      throw new Error("This browser can't hold a signing key. Use the terminal fallback (npm run approve).");
    }
    const server = await apiJson("/api/founder/approval-key");
    let pair = await founderApproval.loadLocalKeyPair();
    if (!pair) {
      if (server.enrolled && server.source === "browser") {
        throw new Error("A signing key is enrolled but not in this browser. Approve from the terminal, or rotate your key.");
      }
      pair = await founderApproval.createLocalKeyPair();
      const publicKeyPem = await founderApproval.exportPublicKeyPem(pair);
      const res = await apiJson("/api/founder/approval-key", { method: "POST", body: JSON.stringify({ publicKeyPem }) });
      showToast(`Approval key enrolled · SHA256 ${String(res.fingerprint || "").slice(0, 16)}…`);
    }
    return pair;
  }

  async function runOneClickApproval(taskId, statePath, statusEl) {
    const setStatus = (msg, err) => { statusEl.hidden = false; statusEl.textContent = msg; statusEl.classList.toggle("danger-text", !!err); };
    // statePath is the exact task-state path the Founder Inbox already knows for
    // this item (objective nodes included); the server prefers it over an id walk.
    const body = (extra = {}) => JSON.stringify({ ...(statePath ? { statePath } : {}), ...extra });
    setStatus("Preparing…");
    const pair = await ensureApprovalKey();
    let prep;
    const res = await api(`/api/founder/approvals/${encodeURIComponent(taskId)}/prepare`, { method: "POST", body: body() });
    prep = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (prep.code === "KEY_MISMATCH") {
        setStatus("This task predates your current key. Re-keying…");
        await apiJson(`/api/founder/approvals/${encodeURIComponent(taskId)}/rekey`, { method: "POST", body: body() });
        return runOneClickApproval(taskId, statePath, statusEl);
      }
      throw new Error(prep.error || `Prepare failed (${res.status})`);
    }
    if (prep.unsigned.taskId !== taskId || !prep.unsigned.challenge) throw new Error("Prepared approval did not match this task.");
    setStatus("Signing in your browser…");
    const signature = await founderApproval.signPayloadString(pair, JSON.stringify(prep.unsigned));
    setStatus("Recording…");
    const out = await apiJson(`/api/founder/approvals/${encodeURIComponent(taskId)}/submit`, {
      method: "POST", body: body({ assertion: { ...prep.unsigned, signature } }),
    });
    setStatus(`Approved — ${out.currentStage ? `resuming at ${out.currentStage}` : "resumed"}.`);
    return out;
  }

  const INBOX_KIND_LABEL = { approval: "Approval", decision: "Decision", blocked: "Blocked", question: "Question" };
  const INBOX_KIND_CLASS = { approval: "badge-warn", decision: "badge-warn", blocked: "health-failed", question: "badge-type" };

  // One Founder Inbox entry, wrapped with a "×" that dismisses it to the
  // "Dismissed" fold below. Dismissing is presentation-only and reversible —
  // it never resolves the decision, approves the build, or unblocks the task.
  function inboxItem(x) {
    return `<div class="inbox-entry" data-inbox-id="${esc(x.id)}">
      <button class="inbox-dismiss" data-dismiss-inbox="${esc(x.id)}" title="Dismiss from your inbox" aria-label="Dismiss from your inbox">×</button>
      ${inboxCardBody(x)}
    </div>`;
  }

  // Compact row for an inbox entry the founder dismissed — shown in the
  // collapsed "Dismissed" fold with a one-click Restore.
  function dismissedInboxRow(x) {
    return `<div class="inbox-dismissed-row">
      <div><strong>${esc(x.title || INBOX_KIND_LABEL[x.kind] || x.kind)}</strong>
      <span class="muted small">${esc(INBOX_KIND_LABEL[x.kind] || x.kind)}${x.project ? ` · ${esc(x.project)}` : ""}${x.taskId ? ` · ${esc(x.taskId)}` : ""}${x.dismissedAt ? ` · dismissed ${esc(fmtTime(x.dismissedAt))}` : ""}</span></div>
      <button class="btn secondary tiny" data-restore-inbox="${esc(x.id)}">Restore</button>
    </div>`;
  }

  // Decisions and approvals reuse the decision-card action buttons; blocked
  // tasks link to their completion report; questions are read-only (this
  // system answers them synchronously).
  function inboxCardBody(x) {
    if (x.kind === "approval") return approvalCard(x);
    if (x.kind === "decision") {
      return decisionCard({
        question: x.title, why: x.detail, project: x.project, taskId: x.taskId, objective: x.objective,
        recommendation: x.recommendation, options: x.options, risk: x.risk, statePath: x.statePath,
      });
    }
    return `<article class="decision-card">
      <div class="decision-top">
        <span class="decision-icon">${x.kind === "blocked" ? "×" : "?"}</span>
        <div><strong>${esc(x.title)}</strong><span>${pill(INBOX_KIND_LABEL[x.kind] || x.kind, INBOX_KIND_CLASS[x.kind] || "badge-type")} ${esc(x.project || "company")}${x.taskId ? ` · <code>${esc(x.taskId)}</code>` : ""}</span></div>
      </div>
      ${x.objective ? `<p class="muted small">Task: ${esc(x.objective)}</p>` : ""}
      <p>${esc(x.detail || "")}</p>
      ${x.kind === "blocked" && x.taskId ? `<div class="decision-choices"><button class="btn" data-retry-task="${esc(x.taskId)}">Retry this task</button><button class="btn secondary" data-report-task="${esc(x.taskId)}">View report</button></div>` : ""}
      ${x.kind === "question" ? `<p class="muted small">Answered synchronously — see the Ask an agent history.</p>` : ""}
    </article>`;
  }

  const NODE_TONE = { good: "health-healthy", info: "badge-type", warn: "badge-warn", bad: "health-failed", neutral: "badge-type" };

  // Today's objective portfolio: ACTIVE (the four founder-attention buckets),
  // then HISTORY, then ARCHIVED — the last two collapsed so old work never
  // dominates. Cards are the compact presenter view; full detail is a click away.
  function renderObjectivePortfolio(objectives) {
    const g = objectiveView.groupObjectives(objectives);
    const card = (o) => objectiveView.renderObjectiveCard(o, { esc });
    const row = (o) => objectiveView.renderObjectiveHistoryRow(o, { esc });
    const group = (label, list) => list.length
      ? `<div class="obj-group"><div class="obj-group-head">${esc(label)} <span class="muted small">${list.length}</span></div>${list.map(card).join("")}</div>`
      : "";
    const activeCount = g.running.length + g.waiting.length + g.blocked.length + g.recentlyCompleted.length;
    return `
      <section class="activity-panel">
        <div class="panel-heading"><div><span class="eyebrow">Active</span><h2>Objectives</h2></div>${activeCount ? pill(activeCount, "badge-type") : pill("Clear", "health-healthy")}</div>
        ${activeCount ? [
          group("Running", g.running),
          group("Waiting for you", g.waiting),
          group("Blocked", g.blocked),
          group("Recently completed", g.recentlyCompleted),
        ].join("") : `<div class="empty-state">No objective needs your attention right now. Older work is in History below.</div>`}
      </section>
      ${g.history.length ? `<section class="activity-panel">
        <details class="obj-fold">
          <summary><span class="eyebrow">History</span> Older objectives <span class="muted small">${g.history.length}</span></summary>
          <div class="obj-fold-list">${g.history.map(row).join("")}</div>
        </details>
      </section>` : ""}
      ${g.archived.length ? `<section class="activity-panel">
        <details class="obj-fold">
          <summary><span class="eyebrow">Archived</span> Dismissed by you — fully recoverable <span class="muted small">${g.archived.length}</span></summary>
          <div class="obj-fold-list">${g.archived.map(row).join("")}</div>
        </details>
      </section>` : ""}`;
  }

  // Drill-down for one objective: the original prompt, the parts with their
  // presenter-normalized status, and archive control. Opened from "Details".
  function renderObjectiveDetails(o) {
    if (!o) return `<p class="muted">Objective not found — reload Today.</p>`;
    if (o.status === "invalid") return `<p class="danger-text">${esc(o.error || "invalid objective state")}</p>`;
    const nodes = (o.nodeBriefs || []).map((n) => `
      <div class="obj-node">
        <div class="obj-node-main">
          <strong>${esc(n.title || n.id)}</strong>
          <span class="muted small">${esc(n.role || "—")}${n.stage ? ` · ${esc(n.stage)}` : ""}${n.elapsedMs != null ? ` · ${esc(fmtDuration(n.elapsedMs))}` : ""}${n.retries ? ` · ${n.retries} retr${n.retries === 1 ? "y" : "ies"}` : ""}${(n.waitingOn || []).length ? ` · needs ${esc(n.waitingOn.join(", "))}` : ""}</span>
          ${n.blocker?.headline ? `<span class="danger-text small">${esc(n.blocker.headline)}</span>` : ""}
        </div>
        <span class="badge ${NODE_TONE[n.statusTone] || "badge-type"}">${esc(n.statusLabel || n.status)}</span>
      </div>`).join("");
    return `
      <div class="obj-detail">
        <p class="muted small">${esc(o.project || "")} · <code>${esc(o.objectiveId)}</code> · ${esc(o.statusLabel || o.status6 || o.status)}${o.archivedAt ? ` · archived ${esc(fmtTime(o.archivedAt))}` : ""}</p>
        ${o.headline ? `<p>${esc(o.headline)}</p>` : ""}
        ${objectiveRecovery.renderObjectiveRecovery(o, { esc }) || ""}
        <h4>Original objective</h4>
        <pre class="report-md obj-detail-prompt">${esc(o.description || o.objective || "")}</pre>
        <h4>Parts (${(o.nodeBriefs || []).length})</h4>
        ${nodes || `<p class="muted small">No parts recorded.</p>`}
        <div class="row-actions">
          <button class="btn secondary" data-report-objective="${esc(o.objectiveId)}">Full report</button>
          ${o.lifecycle === "archived"
            ? `<button class="btn" data-unarchive-objective="${esc(o.objectiveId)}">Unarchive</button>`
            : `<button class="btn" data-archive-objective="${esc(o.objectiveId)}">Archive from Today</button>`}
        </div>
        <p class="muted small">Archiving changes only where this appears — its state, report, evidence, metrics, and GitHub history are kept.</p>
      </div>`;
  }

  function executionBadge(status) {
    const tone = { working: "badge-type", completed: "health-healthy", blocked: "badge-warn", failed: "health-failed", pending: "badge-type" }[status] || "badge-type";
    return `<span class="badge ${tone}">${esc(status || "pending")}</span>`;
  }

  function renderExecutionView(x) {
    const blocked = x.blocker || null;
    const current = x.currentAgent || x.currentStage;
    const currentText = current
      ? `${esc(x.currentAgent || "Factory")} · ${esc(x.currentActivity || x.currentStage || "working")}`
      : (blocked ? "Waiting for a blocker to be resolved" : "No agent is currently running");
    const events = (x.events || []).slice().reverse();
    return `<div class="execution-view">
      <div class="execution-summary">
        <div><span class="eyebrow">${esc(x.project || "Factory")}</span><h3>${esc(x.objective || x.objectiveId)}</h3><p class="muted small">${esc(x.objectiveId)} · ${esc(x.status || "—")} · ${x.elapsedMs != null ? esc(fmtDuration(x.elapsedMs)) : "elapsed unavailable"}</p></div>
        ${executionBadge(x.status === "active" ? "working" : x.status)}
      </div>
      <div class="execution-current ${blocked ? "execution-blocked" : ""}"><span class="eyebrow">${blocked ? "BLOCKED" : x.currentActivity?.startsWith("Waiting") ? "WAITING" : current ? "CURRENTLY WORKING" : "IDLE"}</span><strong>${currentText}</strong>${blocked ? `<p class="danger-text small">${esc(blocked.summary || blocked.outcome || "The objective cannot continue")}</p>` : ""}</div>
      <h4>Execution pipeline</h4>
      <div class="execution-pipeline">${(x.stages || []).map((s) => `<div class="execution-stage"><div><strong>${esc(s.stage)}</strong><span class="muted small">${s.agent ? ` · ${esc(s.agent)}` : ""}${s.nodeId ? ` · ${esc(s.nodeId)}` : ""}</span>${s.activity ? `<small class="muted">${esc(s.activity)}</small>` : ""}</div>${executionBadge(s.status)}</div>`).join("")}</div>
      <h4>Live activity <span class="muted small">${events.length} recorded event${events.length === 1 ? "" : "s"}</span></h4>
      <div class="execution-feed">${events.length ? events.map((e) => `<div class="execution-event"><time>${esc(fmtTime(e.at))}</time><div><strong>${esc(e.source || "Factory")}${e.destination ? ` → ${esc(e.destination)}` : ""}</strong><span class="muted small">${esc(e.type)}${e.stage ? ` · ${esc(e.stage)}` : ""}</span><p>${esc(e.message)}</p></div></div>`).join("") : `<p class="muted small">No execution events recorded yet.</p>`}</div>
      ${(x.evidence || []).length ? `<h4>Evidence</h4><div class="execution-evidence">${x.evidence.map((e) => `<span>${esc(e.stage)} · ${esc(e.path)}</span>`).join("")}</div>` : ""}
      ${x.github?.prUrl ? `<p class="small"><a href="${esc(x.github.prUrl)}" target="_blank" rel="noreferrer">Open pull request ↗</a></p>` : ""}
    </div>`;
  }

  async function openExecutionView(id) {
    if (executionPoll) clearInterval(executionPoll);
    openModal("Task execution", `<p class="muted">Loading the durable execution record…</p>`);
    const refresh = async () => {
      try {
        const execution = await apiJson(`/api/founder/objectives/${encodeURIComponent(id)}/execution`);
        if (!modal.hidden) modalBody.innerHTML = renderExecutionView(execution);
        if (execution.status !== "active" && executionPoll) { clearInterval(executionPoll); executionPoll = null; }
      } catch (e) {
        if (!modal.hidden) modalBody.innerHTML = `<p class="danger-text">${esc(e.message)}</p>`;
      }
    };
    await refresh();
    executionPoll = setInterval(refresh, 2500);
  }

  async function openTaskExecutionView(id) {
    if (executionPoll) clearInterval(executionPoll);
    openModal("Task execution", `<p class="muted">Loading the durable execution record…</p>`);
    const refresh = async () => {
      try {
        const execution = await apiJson(`/api/founder/tasks/${encodeURIComponent(id)}/execution`);
        if (!modal.hidden) modalBody.innerHTML = renderExecutionView(execution);
        if (execution.status !== "active" && executionPoll) { clearInterval(executionPoll); executionPoll = null; }
      } catch (e) {
        if (!modal.hidden) modalBody.innerHTML = `<p class="danger-text">${esc(e.message)}</p>`;
      }
    };
    await refresh();
    executionPoll = setInterval(refresh, 2500);
  }

  function bindFounderControls() {
    const project = document.getElementById("founder-project");
    const selfNote = document.getElementById("founder-self-note");
    const syncSelfNote = () => {
      const v = project.value;
      if (selfNote) selfNote.hidden = !(v === "openclaw-factory" || /headquarter/i.test(project.selectedOptions[0]?.textContent || ""));
    };
    project.onchange = () => { const repo = project.selectedOptions[0]?.dataset.repo; if (repo) document.getElementById("founder-repo").value = repo; syncSelfNote(); };
    syncSelfNote();
    app.querySelectorAll("[data-refresh-ai-usage]").forEach((button) => button.onclick = () => {
      button.disabled = true;
      route().finally(() => { button.disabled = false; });
    });
    app.querySelectorAll(".founder-presets .chip").forEach((chip) => chip.onclick = () => {
      document.getElementById("founder-objective").value = chip.dataset.preset;
      document.getElementById("founder-decompose").checked = true;
      const hq = [...project.options].find((o) => o.value === "openclaw-factory" || /headquarter/i.test(o.textContent));
      if (hq) { project.value = hq.value; project.dispatchEvent(new Event("change")); }
      document.getElementById("founder-objective").focus();
    });
    document.getElementById("founder-command").onsubmit = async (e) => {
      e.preventDefault();
      const decompose = document.getElementById("founder-decompose")?.checked;
      const endpoint = decompose ? "/api/founder/objectives" : "/api/founder/tasks";
      const repo = document.getElementById("founder-repo").value.trim();
      const objective = document.getElementById("founder-objective").value.trim();
      if (!objective) { showToast("Describe the outcome you want first.", true); return; }
      if (!project.value) { showToast("Pick a project.", true); return; }
      try {
        await apiJson(endpoint, { method: "POST", body: JSON.stringify({ objective, projectId: project.value, ...(repo ? { repo } : {}) }) });
        showToast("Created. Your team is on it — follow it in “Running now” below.");
        document.getElementById("founder-objective").value = "";
        setTimeout(route, 800);
      } catch (err) { showToast(err.message, true); }
    };
    app.querySelectorAll("[data-retry-task]").forEach((btn) => btn.onclick = async () => {
      btn.disabled = true; btn.textContent = "Retrying…";
      try {
        await apiJson(`/api/founder/tasks/${btn.dataset.retryTask}/retry`, { method: "POST" });
        showToast("Retrying now.");
        setTimeout(route, 800);
      } catch (e) { showToast(e.message, true); btn.disabled = false; btn.textContent = "Retry now"; }
    });
    app.querySelectorAll("[data-dismiss-inbox]").forEach((btn) => btn.onclick = async () => {
      btn.disabled = true;
      try {
        await apiJson("/api/founder/inbox/dismiss", { method: "POST", body: JSON.stringify({ id: btn.dataset.dismissInbox }) });
        showToast("Dismissed. It's in “Dismissed” at the bottom of your inbox — restore it any time.");
        route();
      } catch (e) { showToast(e.message, true); btn.disabled = false; }
    });
    app.querySelectorAll("[data-restore-inbox]").forEach((btn) => btn.onclick = async () => {
      btn.disabled = true;
      try {
        await apiJson("/api/founder/inbox/dismiss", { method: "POST", body: JSON.stringify({ id: btn.dataset.restoreInbox, restore: true }) });
        showToast("Restored to your inbox.");
        route();
      } catch (e) { showToast(e.message, true); btn.disabled = false; }
    });
    objectiveRecovery.bindObjectiveRecovery(app, {
      request: apiJson,
      notify: showToast,
      refresh: route,
    });
    app.querySelectorAll("[data-resolve-choice]").forEach((btn) => btn.onclick = async () => {
      btn.disabled = true;
      try {
        await apiJson("/api/founder/decisions/resolve", { method: "POST", body: JSON.stringify({ statePath: btn.dataset.resolveChoice, direction: btn.dataset.choice }) });
        showToast(`Answered: “${btn.dataset.choice}”. Work resumed.`);
        route();
      } catch (e) { showToast(e.message, true); btn.disabled = false; }
    });
    app.querySelectorAll("[data-resolve-decision]").forEach((btn) => btn.onclick = () => { openModal("Answer in your own words", `<label class="field-label">Your direction for the team</label><textarea class="editor" id="decision-direction" placeholder="Go with option A because…"></textarea><button class="btn" id="submit-decision">Send &amp; resume</button>`); document.getElementById("submit-decision").onclick = async () => { const dir = document.getElementById("decision-direction").value.trim(); if (!dir) { showToast("Type a direction first.", true); return; } try { await apiJson("/api/founder/decisions/resolve", { method: "POST", body: JSON.stringify({ statePath: btn.dataset.resolveDecision, direction: dir }) }); closeModal(); showToast("Decision recorded. Work resumed."); route(); } catch (e) { showToast(e.message, true); } }; });
    app.querySelectorAll("[data-approve]").forEach((btn) => btn.onclick = async () => {
      const card = btn.closest("[data-approval-task]");
      const statusEl = card?.querySelector("[data-approve-status]") || document.createElement("div");
      card?.querySelectorAll("button").forEach((b) => b.disabled = true);
      try {
        await runOneClickApproval(btn.dataset.approve, card?.dataset.approvalStatepath || "", statusEl);
        showToast("Approved — the factory is resuming.");
        setTimeout(route, 900);
      } catch (e) {
        statusEl.hidden = false; statusEl.textContent = e.message; statusEl.classList.add("danger-text");
        showToast(e.message, true);
        card?.querySelectorAll("button").forEach((b) => b.disabled = false);
      }
    });
    app.querySelectorAll("[data-reject]").forEach((btn) => btn.onclick = () => {
      const statePath = btn.closest("[data-approval-task]")?.dataset.approvalStatepath || "";
      openModal("Reject this high-risk build", `<p class="muted small">The task stops here. It will not resume.</p><label class="field-label">Reason (optional, recorded)</label><textarea class="editor" id="reject-reason" placeholder="Not now — revisit after the infra work lands"></textarea><button class="btn" id="submit-reject">Reject</button>`);
      document.getElementById("submit-reject").onclick = async () => {
        try {
          await apiJson(`/api/founder/approvals/${encodeURIComponent(btn.dataset.reject)}/reject`, { method: "POST", body: JSON.stringify({ reason: document.getElementById("reject-reason").value, ...(statePath ? { statePath } : {}) }) });
          closeModal(); showToast("Rejected. The task has stopped."); route();
        } catch (e) { showToast(e.message, true); }
      };
    });
    document.getElementById("ask-agent").onclick = () => { openModal("Ask an agent", `<label class="field-label">Agent</label><input class="modal-input" id="question-agent" value="main"/><label class="field-label">Question</label><textarea class="editor" id="question-text" placeholder="What is blocking this project?"></textarea><button class="btn" id="send-question">Ask</button><div id="question-answer"></div>`); document.getElementById("send-question").onclick = async () => { const out = document.getElementById("question-answer"); out.innerHTML = `<p class="muted">Agent is thinking…</p>`; try { const j = await apiJson("/api/founder/questions", { method: "POST", body: JSON.stringify({ agentId: document.getElementById("question-agent").value, question: document.getElementById("question-text").value }) }); out.innerHTML = `<div class="card">${esc(j.question.answer)}</div>`; } catch (e) { out.innerHTML = `<p class="danger-text">${esc(e.message)}</p>`; } }; };
    bindObjectiveControls(app);
  }

  async function archiveObjective(id, archived) {
    try {
      await apiJson(`/api/founder/objectives/${id}/${archived ? "archive" : "unarchive"}`, { method: "POST" });
      showToast(archived
        ? "Archived. It's in the Archived section on Today — state, reports, and history are kept."
        : "Restored to the active view.");
      closeModal();
      route();
    } catch (e) { showToast(e.message, true); }
  }

  // Wire the objective card / history-row / details-modal controls within a
  // scope (the page, or the modal body after a re-render).
  function bindObjectiveControls(scope) {
    scope.querySelectorAll("[data-report-task]").forEach((btn) => btn.onclick = () => openReportDrilldown("task", btn.dataset.reportTask));
    scope.querySelectorAll("[data-task-execution]").forEach((btn) => btn.onclick = () => openTaskExecutionView(btn.dataset.taskExecution));
    scope.querySelectorAll("[data-objective-execution]").forEach((btn) => btn.onclick = () => openExecutionView(btn.dataset.objectiveExecution));
    scope.querySelectorAll("[data-report-objective]").forEach((btn) => btn.onclick = () => openReportDrilldown("objective", btn.dataset.reportObjective));
    scope.querySelectorAll("[data-objective-details]").forEach((btn) => btn.onclick = () => {
      openExecutionView(btn.dataset.objectiveDetails);
    });
    scope.querySelectorAll("[data-archive-objective]").forEach((btn) => btn.onclick = () => archiveObjective(btn.dataset.archiveObjective, true));
    scope.querySelectorAll("[data-unarchive-objective]").forEach((btn) => btn.onclick = () => archiveObjective(btn.dataset.unarchiveObjective, false));
  }

  // Read the report, then drill into timeline / evidence / GitHub — no terminal.
  async function openReportDrilldown(kind, id) {
    openModal(`${kind === "objective" ? "Objective" : "Task"} report — ${id}`, `<p class="muted">Loading…</p>`);
    const reportUrl = kind === "objective" ? `/api/founder/objectives/${id}/report` : `/api/founder/tasks/${id}/report`;
    try {
      const r = await apiJson(reportUrl);
      const reportHtml = r.html
        ? `<div class="report-rendered">${r.html}</div>`
        : `<p class="muted">No report has been generated yet${r.status ? ` (status: ${esc(r.status)})` : ""}.</p>`;
      let evidenceHtml = "";
      if (kind === "task") {
        try {
          const ev = await apiJson(`/api/founder/tasks/${id}/evidence`);
          evidenceHtml = renderEvidence(ev);
        } catch { evidenceHtml = ""; }
      }
      modalBody.innerHTML = reportHtml + evidenceHtml;
    } catch (e) {
      modalBody.innerHTML = `<p class="danger-text">${esc(e.message)}</p>`;
    }
  }

  function renderEvidence(ev) {
    const gp = ev.githubPublish;
    const github = gp
      ? `<p class="small">${gp.published ? (gp.prUrl ? `PR: <a href="${esc(gp.prUrl)}" target="_blank" rel="noreferrer">${esc(gp.prUrl)}</a>` : "branch pushed") : `not published — ${esc(gp.reason || "?")}`}${gp.commitSha ? ` · commit <code>${esc(String(gp.commitSha).slice(0, 10))}</code>` : ""}${ev.branch ? ` · branch <code>${esc(ev.branch)}</code>` : ""}</p>`
      : (ev.branch ? `<p class="small">branch <code>${esc(ev.branch)}</code></p>` : "");
    const stages = Object.entries(ev.evidenceByStage || {});
    const evBlocks = stages.length
      ? stages.map(([stage, items]) => `
          <details class="drill">
            <summary>${esc(stage)} — ${items.length} artifact${items.length === 1 ? "" : "s"}${items.flatMap((i) => i.verdicts || []).length ? ` · ${esc([...new Set(items.flatMap((i) => i.verdicts || []))].join(", "))}` : ""}</summary>
            ${items.map((i) => `<div class="ev-item"><div class="muted small">${esc(i.path)}</div><pre class="report-md">${esc(i.excerpt || "")}</pre></div>`).join("")}
          </details>`).join("")
      : `<p class="muted small">No evidence excerpts recorded (the worktree may have been cleaned up).</p>`;
    const timeline = (ev.events || []).slice(0, 40).map((e) => `<li><time>${esc(fmtTime(e.at))}</time> <strong>${esc(String(e.type || "").replaceAll("-", " "))}</strong>${e.stage ? ` · ${esc(e.stage)}` : ""}${e.actor ? ` · ${esc(e.actor)}` : ""}${e.outcome ? ` → ${esc(e.outcome)}` : ""}</li>`).join("");
    return `
      <hr/>
      <h4>GitHub</h4>${github || `<p class="muted small">not published from this task</p>`}
      <h4>Evidence by stage</h4>${evBlocks}
      <details class="drill"><summary>Full timeline (${(ev.events || []).length} events)</summary><ul class="timeline">${timeline}</ul></details>`;
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
              <em>${esc(railStatus(a, runtime))}${a.currentTask && a.elapsedMs != null ? ` · ${esc(a.currentTask.stage || "—")} · ${esc(fmtDuration(a.elapsedMs))}` : ""}</em>
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
    const [state, labAgents, policyResp] = await Promise.all([
      loadCompany(),
      apiJson("/api/agents").catch(() => ({ agents: [] })),
      apiJson("/api/hq/role-policy").catch(() => ({ roles: {} })),
    ]);
    const agents = state.agents?.agents || [];
    const runtime = state.runtime;
    const reconciliation = state.rosterReconciliation;
    const policy = policyResp.roles || {};
    for (const a of agents) a.policy = policy[a.id] || null;

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
          <dt>Model</dt><dd>${a.policy?.model ? `${esc(a.policy.model.primary)}${a.policy.model.inherited ? " (default)" : ""}${(a.policy.model.fallbacks || []).length ? ` <span class="muted small">→ ${esc((a.policy.model.fallbacks || []).join(", "))}</span>` : ""}` : "—"}</dd>
          <dt>Runtime agent id</dt><dd>${esc(a.runtimeAgentId || "—")}</dd>
          <dt>Runtime</dt><dd>${esc(runtimeNoteFor(a, runtime))}</dd>
          <dt>Current project</dt><dd>${esc(a.currentProject || "—")}</dd>
          <dt>Current task</dt><dd>${esc(a.currentTask?.objective || "—")}</dd>
          <dt>Stage</dt><dd>${esc(a.currentTask?.stage || "—")}</dd>
          <dt>Elapsed</dt><dd>${esc(a.elapsedMs != null ? fmtDuration(a.elapsedMs) : "—")}</dd>
          <dt>Last handoff</dt><dd>${esc(a.lastHandoffAt ? fmtTime(a.lastHandoffAt) : "—")}</dd>
          <dt>Last result</dt><dd>${esc(fmtLastResult(a.lastResult))}</dd>
          <dt>Blocker</dt><dd>${esc(a.blocker || "—")}</dd>
          <dt>Last activity</dt><dd>${esc(a.lastActivityAt ? fmtTime(a.lastActivityAt) : "—")}${a.sinceLastActivityMs != null ? ` (${esc(fmtDuration(a.sinceLastActivityMs))} ago)` : ""}</dd>
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
