import { STAGE_LABEL } from "/lib/stage-vocabulary.mjs";
import { BOARD_COLUMNS, buildBoard, filterByProject } from "/lib/board.mjs";
import * as objectiveRecovery from "/lib/objectiveRecovery.mjs";
import * as founderApproval from "/lib/founderApproval.mjs";
import * as objectiveView from "/lib/objectiveView.mjs";
import { costLimitsPanel } from "/cost-limits.mjs";
import { operationsPanel } from "/lib/operationsView.mjs";
import { renderFounderInboxCard, renderFounderInboxEmpty } from "/lib/founderInbox.mjs";
import { goalsPanel } from "/lib/goalsView.mjs";
import { proposerPanel } from "/lib/proposerView.mjs";
import { blastRadiusPanel } from "/lib/blastRadiusView.mjs";
import { deploymentsPanel } from "/lib/deploymentsView.mjs";
import { interactionsSection } from "/lib/interactionsView.mjs";
import { retentionPanel } from "/lib/retentionView.mjs";
import { readinessPanel } from "/lib/readinessView.mjs";
import { runTimelineSection } from "/lib/timelineView.mjs";
import { decisionsPanel } from "/lib/decisionsView.mjs";
import { searchPanel } from "/lib/searchView.mjs";
import { scorecardsPanel } from "/lib/scorecardsView.mjs";
import { budgetPanel } from "/lib/budgetView.mjs";
import { permissionsPanel } from "/lib/permissionsView.mjs";

(function () {
  const app = document.getElementById("app");
  const nav = document.getElementById("nav");
  const toastEl = document.getElementById("toast");
  const modal = document.getElementById("modal");
  const modalTitle = document.getElementById("modal-title");
  const modalBody = document.getElementById("modal-body");

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
    try {
      await api("/api/auth/logout", { method: "POST" });
    } catch {
      /* logging out locally regardless */
    }
    location.href = "/login.html";
  };

  // CSRF token for this session. Fetched once on boot from /api/auth/me and
  // refreshed if the server ever tells us it is stale.
  let csrfToken = null;

  async function refreshCsrfToken() {
    try {
      const res = await fetch("/api/auth/me", { credentials: "include" });
      if (!res.ok) return null;
      const data = await res.json();
      csrfToken = data.csrfToken || null;
    } catch {
      csrfToken = null;
    }
    return csrfToken;
  }

  async function api(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (opts.body && typeof opts.body === "string" && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    const method = String(opts.method || "GET").toUpperCase();
    const mutating = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
    if (mutating) {
      if (!csrfToken) await refreshCsrfToken();
      if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
    }

    let res = await fetch(path, { credentials: "include", ...opts, headers });

    // A rotated session (or a server restart) invalidates the token we hold.
    // Re-fetch once and retry, so a founder never sees a spurious CSRF error.
    if (mutating && res.status === 403) {
      const refreshed = await refreshCsrfToken();
      if (refreshed) {
        res = await fetch(path, {
          credentials: "include",
          ...opts,
          headers: { ...headers, "X-CSRF-Token": refreshed },
        });
      }
    }

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
      if (res.status === 524 || res.status === 504) {
        throw new Error("The dashboard gateway timed out waiting for OpenClaw. The request may still be running; check Today before trying again.");
      }
      throw new Error(`The dashboard returned an unexpected response (${res.status}). Please try again.`);
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

  function workTargets(state, projects = state.projects || []) {
    return state.headquarters
      ? [...projects, { ...state.headquarters, isHeadquarters: true }]
      : projects;
  }

  function riskSeverityOrder(a, b) {
    return (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3);
  }

  // Four surfaces retired on 2026-09-15. Each read a 3-byte file or a
  // pre-factory table that the factory has never written to, while the real
  // answer to the same question already existed elsewhere and was better.
  const RETIRED = {
    sops: {
      title: "SOPs",
      why: "This page read dashboard/backend/data/hq/sops.json, which was an empty array. Nothing ever wrote to it.",
      instead: null,
    },
    logs: {
      title: "Logs",
      why: "This page read the pre-factory agent_runs table, which holds one row. The factory records its work somewhere else entirely.",
      instead: ["#/today", "Open a task from Today — its execution view has the real timeline and evidence"],
    },
    reports: {
      title: "Reports",
      why: "This page read dashboard/backend/data/hq/reports.json, which was an empty array. Real per-task reports have existed all along on a route this page never called.",
      instead: ["#/today", "Today lists what finished; opening one shows its real report"],
    },
    runs: {
      title: "Runs",
      why: "Same pre-factory agent_runs table as Logs — one row, never written to by the factory.",
      instead: ["#/today", "Open a task from Today for the stage-by-stage execution record"],
    },
  };

  function parseRoute() {
    const raw = (location.hash || "#/today").replace(/^#\/?/, "");
    const segs = raw.split("/").filter(Boolean);
    if (!segs.length || segs[0] === "today" || segs[0] === "home") return { name: "today" };
    if (["agents", "projects", "tasks"].includes(segs[0])) return { name: segs[0] };
    // SOPs, Logs, Reports and Runs were retired. A bookmark to one of them
    // must say where its content went; falling through to Today would look
    // like the page had simply moved.
    if (RETIRED[segs[0]]) return { name: "retired", id: segs[0] };
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
      ["#/tasks", "tasks", "Board"],
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

  function pill(text, kind) {
    return `<span class="badge ${kind || "badge-type"}">${esc(text)}</span>`;
  }

  // ── Today: the founder observability surface ───────────────────

  async function renderToday() {
    const [state, fc, learning, objectivesResp, autonomy, costs, planLimits, overnight, operations, goals, proposals, decisions, scorecards, budgets, permissions, blastRadius, deployments, retention, readiness] = await Promise.all([
      loadCompany(),
      apiJson("/api/founder/overview").catch(() => ({ jobs: [] })),
      loadLearning().catch(() => null),
      apiJson("/api/founder/objectives").catch(() => ({ objectives: [], summary: {} })),
      apiJson("/api/hq/autonomy").catch(() => null),
      apiJson("/api/hq/costs").catch(() => null),
      apiJson("/api/hq/plan-limits").catch(() => null),
      apiJson("/api/founder/overnight").catch(() => ({ status: "unavailable", items: [] })),
      apiJson("/api/hq/operations").catch(() => null),
      apiJson("/api/hq/goals").catch(() => null),
      apiJson("/api/hq/proposals").catch(() => null),
      apiJson("/api/hq/decisions").catch(() => null),
      apiJson("/api/hq/scorecards").catch(() => null),
      apiJson("/api/hq/budgets").catch(() => null),
      apiJson("/api/hq/permissions").catch(() => null),
      apiJson("/api/hq/blast-radius").catch(() => null),
      apiJson("/api/hq/deployments").catch(() => null),
      apiJson("/api/hq/retention").catch(() => null),
      apiJson("/api/hq/readiness").catch(() => null),
    ]);
    const objectives = objectivesResp.objectives || [];
    objectivesById = Object.fromEntries(objectives.map((o) => [o.objectiveId, o]));
    const projects = state.projects || [];
    const agents = state.agents?.agents || [];
    const inbox = fc.inbox || [];
    const dismissedInbox = fc.dismissedInbox || [];
    // "Needs you" counts what the founder can actually act on. The translated
    // item knows: priority 5 is informational (a recorded question), never a page.
    const inboxActionable = inbox.filter((i) => (i.founder ? i.founder.priority < 5 : i.action && i.action !== "none")).length;
    const jobs = fc.jobs || [];
    const allTasks = fc.tasks || [];
    const autoRecovering = fc.autoRecovering || [];
    const finishedTasks = allTasks.filter((t) => t.completionReport || t.status === "merge-ready" || t.status === "merged");
    const runningRows = buildRunningNow(objectives, allTasks, agents);
    // Founder jobs that are live (not yet decomposed into visible nodes) — the
    // "your request was received, agents are on it" confirmation.
    const liveJobs = jobs.filter((j) => j.status === "starting" || j.status === "running" || j.status === "decomposing");

    app.innerHTML = renderFounderHome({ state, projects, agents, inbox, dismissedInbox, objectives, allTasks, runningRows, liveJobs, autoRecovering, finishedTasks, inboxActionable, overnight, operations, goals, proposals, decisions, scorecards, budgets, permissions, blastRadius, deployments, retention, readiness });
    bindFounderControls();
    return;

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

          ${renderOvernightPlan(overnight, projects)}

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
            <div class="panel-heading"><div><span class="eyebrow">Activity</span><h2>What the factory has done</h2></div><span class="muted small">most recent ${(state.activityFeed || []).length}, newest first</span></div>
            <div class="company-feed">
              ${(state.activityFeed || []).map((e) => `<div class="company-event"><span>${esc(String(e.type || "event").replaceAll("-", " "))}</span><strong>${esc(e.taskId)}</strong>${e.actor ? ` <span class="company-actor">${esc(e.actor)}</span>` : ""}${e.stage ? ` <span class="muted small">${esc(STAGE_LABEL[e.stage] || e.stage)}</span>` : ""}<time>${esc(fmtTime(e.at))}</time></div>`).join("") || `<div class="empty-state">No factory task has run in this environment yet.</div>`}
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

  function renderOvernightPlan(plan, projects) {
    if (!plan || plan.status === "unavailable") return "";
    const running = plan.status === "running";
    return `<section class="activity-panel overnight-panel">
      <div class="panel-heading"><div><span class="eyebrow">Overnight work</span><h2>Plan the night</h2></div>${pill(plan.status, running ? "health-healthy" : "badge-type")}</div>
      <p class="muted small">Queue up to ${esc(plan.limit || 8)} big objectives. Start is explicit; each item uses the normal factory worktrees, review, QA, security, and founder-merge gates.</p>
      <form id="overnight-add" class="founder-command-row">
        <textarea id="overnight-objective" rows="2" placeholder="One substantial objective for tonight…" required ${running ? "disabled" : ""}></textarea>
        <select id="overnight-project" required ${running ? "disabled" : ""}><option value="">Choose project</option>${projects.map((p) => `<option value="${esc(p.key)}" data-repo="${esc(p.repo || "")}">${esc(p.name)}${p.isHeadquarters ? " (factory)" : ""}</option>`).join("")}</select>
        <button class="btn" type="submit" ${running ? "disabled" : ""}>Add to tonight</button>
      </form>
      <div class="company-feed">${(plan.items || []).map((item, i) => `<div class="company-agent"><span class="activity-pulse ${item.status === "running" ? "pulse-live" : item.status === "failed" ? "pulse-error" : ""}"></span><div><strong>${i + 1}. ${esc(item.objective)}</strong><small class="muted">${esc(item.projectId)} · ${esc(item.status)}${item.exitCode != null ? ` · exit ${esc(item.exitCode)}` : ""}</small></div>${!running && item.status !== "complete" ? `<button class="btn secondary tiny" data-remove-night="${esc(item.id)}">Remove</button>` : ""}</div>`).join("") || `<div class="empty-state">Nothing planned yet.</div>`}</div>
      ${plan.status === "needs-attention" ? `<p role="alert">Some overnight work stopped before delivery. Review the Founder Inbox before retrying it. Failed requests are not automatically submitted again.</p>` : ""}
      <div class="row-actions">${running ? `<button class="btn secondary" id="stop-overnight" ${plan.stopRequested ? "disabled" : ""}>${plan.stopRequested ? "Stopping after this objective…" : "Stop after the current objective"}</button>` : `<button class="btn founder-launch" id="start-overnight" ${!(plan.items || []).some((x) => x.status === "queued") ? "disabled" : ""}>Start overnight work →</button>`}</div>
    </section>`;
  }

  function renderFounderHome({ state, projects, agents, inbox, dismissedInbox, objectives, allTasks, runningRows, liveJobs, autoRecovering, finishedTasks, inboxActionable, overnight, operations, goals, proposals, decisions, scorecards, budgets, permissions, blastRadius, deployments, retention, readiness }) {
    const groups = objectiveView.groupObjectives(objectives);
    const active = [...groups.running, ...groups.waiting, ...groups.blocked];
    const workingAgents = runningRows.filter((row) => row.status === "working");
    const nowLine = workingAgents.length ? `${workingAgents.length} agent${workingAgents.length === 1 ? " is" : "s are"} working right now.` : "No agents are actively working right now.";
    const targets = workTargets(state, projects);
    return `<div class="founder-home">
      <header class="founder-topline"><div><span class="eyebrow">Founder command center</span><h1>What is the factory doing?</h1><p>${esc(nowLine)} Here is the work that matters.</p></div><button class="btn secondary" id="ask-agent">Ask the factory</button></header>
      <form id="founder-command" class="founder-launcher"><textarea id="founder-objective" rows="1" placeholder="Start a new outcome…" required></textarea><select id="founder-project" required><option value="">Choose project</option>${targets.map((p) => `<option value="${esc(p.key)}" data-repo="${esc(p.repo || "")}">${esc(p.name)}${p.isHeadquarters ? " (factory)" : ""}</option>`).join("")}</select><input id="founder-repo" type="hidden"/><input id="founder-decompose" type="checkbox" checked hidden/><button class="btn founder-launch" type="submit">Start an outcome</button></form>
      ${renderOvernightPlan(overnight, targets)}
      <div class="founder-pulse"><div><span class="eyebrow">Factory pulse</span><strong>${active.length ? `${active.length} active objective${active.length === 1 ? "" : "s"}` : "All clear"}</strong></div><div><span>Working</span><b>${workingAgents.length}</b></div><div><span>Waiting for you</span><b class="${inboxActionable ? "pulse-attention" : ""}">${inboxActionable}</b></div><div><span>Recently complete</span><b>${groups.recentlyCompleted.length}</b></div></div>
      ${renderNeedsYou(inbox, dismissedInbox, inboxActionable)}
      <div class="founder-columns"><main>
        <section class="founder-section"><div class="section-heading"><div><span class="eyebrow">In motion</span><h2>Active objectives</h2></div><span class="section-count">${active.length}</span></div>${active.map((o) => founderObjectiveCard(o)).join("") || `<div class="quiet-state">Nothing is running. Start an outcome above.</div>`}</section>
        <section class="founder-section"><div class="section-heading"><div><span class="eyebrow">Live floor</span><h2>Agents at work</h2></div></div>${[...liveJobs.map((j) => ({ title: j.objective, sub: "Starting the team", status: "starting" })), ...autoRecovering.map((r) => ({ title: r.objective || r.taskId, sub: "Recovering a safe infrastructure failure", status: "recovering" })), ...runningRows].map((r) => `<div class="agent-work-row"><span class="status-dot ${r.status === "working" ? "is-working" : "is-waiting"}"></span><div><strong>${esc(r.title || r.objective || "Factory work")}</strong><span>${esc(r.sub || `${r.agent || "Agent"} · ${r.stage || "next stage"}`)}</span></div><em>${esc(r.status || "waiting")}</em></div>`).join("") || `<div class="quiet-state">The floor is quiet.</div>`}</section>
      </main><aside>
        <section class="founder-section"><div class="section-heading"><div><span class="eyebrow">Recently</span><h2>Completed</h2></div></div>${groups.recentlyCompleted.slice(0, 3).map((o) => founderObjectiveCard(o, true)).join("") || `<div class="quiet-state">No recent completions.</div>`}</section>
        ${renderSearchBox()}
        ${proposerPanel(proposals, { esc })}
        ${goalsPanel(goals, { esc })}
        ${retentionPanel(retention, { esc, fmtTime })}
        ${readinessPanel(readiness, { esc })}
        ${decisionsPanel(decisions, { esc, fmtTime })}
        ${operationsPanel(operations, { esc, fmtTime })}
        ${budgetPanel(budgets, { esc })}
        ${permissionsPanel(permissions, { esc, fmtTime })}
        ${blastRadiusPanel(blastRadius, { esc })}
        ${deploymentsPanel(deployments, { esc, fmtTime })}
        ${scorecardsPanel(scorecards, { esc })}
      </aside></div>
    </div>`;
  }

  // One place to ask "where was this discussed?". The results container starts
  // empty and is filled by the handler below; nothing is fetched until the
  // operator asks, because a search with no query has nothing to say.
  function renderSearchBox() {
    return `<section class="founder-section search-box" aria-labelledby="factory-search-box-title">
      <div class="section-heading"><div><span class="eyebrow">Search</span><h2 id="factory-search-box-title">Find it in the record</h2></div></div>
      <form id="hq-search" class="founder-command-row"><input id="hq-search-q" type="search" placeholder="Search goals, decisions, comments, run events, evidence" autocomplete="off"/><button class="btn secondary tiny" type="submit">Search</button></form>
      <div id="hq-search-results"></div>
    </section>`;
  }

  // The Founder Inbox. It sits above everything else and stays full width:
  // it is the one surface that is about the founder rather than the factory.
  // Sorted and worded by the backend translation (factory/lib/hq/founder-inbox.mjs);
  // this only decides where it lives on the page.
  function renderNeedsYou(inbox, dismissedInbox = [], inboxActionable = 0) {
    return `<section class="founder-section attention-section needs-you">
      <div class="section-heading"><div><span class="eyebrow">Your turn</span><h2>Needs you</h2></div>${inboxActionable ? `<span class="section-count">${inboxActionable}</span>` : ""}</div>
      ${inbox.map((x) => inboxItem(x)).join("") || renderFounderInboxEmpty()}
      ${dismissedInbox.length ? `<details class="inbox-fold">
        <summary>Dismissed by you <span class="muted small">${dismissedInbox.length}</span></summary>
        <div class="inbox-fold-list">${dismissedInbox.map((x) => dismissedInboxRow(x)).join("")}</div>
      </details>` : ""}
    </section>`;
  }

  function founderObjectiveCard(o, compact = false) {
    const running = (o.nodeBriefs || []).find((n) => n.status === "RUNNING");
    const current = running ? `${running.role || "Agent"} · ${running.stage || "working"}` : (o.nextAction?.label || "Waiting for the next safe step");
    const title = objectiveView.shortObjectiveTitle(o.title || o.objective || o.objectiveId);
    return `<article class="founder-objective ${compact ? "is-compact" : ""}" data-objective-details="${esc(o.objectiveId)}"><div class="objective-head"><div><span class="eyebrow">${esc(o.project || "Factory")}</span><h3>${esc(title)}</h3></div><span class="objective-status status-${esc(String(o.statusTone || "info"))}">${esc(o.statusLabel || o.status6 || "In progress")}</span></div><p class="objective-headline">${esc(o.headline || "The team is moving this outcome forward.")}</p><div class="objective-progress"><span style="width:${Math.max(0, Math.min(100, Number(o.progress?.percent) || 0))}%"></span></div><div class="objective-now"><span>NOW</span><strong>${esc(current)}</strong></div><div class="objective-foot"><span>${esc(o.progress?.label || "Progress updating")}</span><button class="btn secondary tiny" data-objective-details="${esc(o.objectiveId)}">Watch factory ↗</button></div></article>`;
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
        kind: "task", taskId: t.id, title: objectiveView.shortObjectiveTitle(t.objective || t.id), sub: t.project || t.id,
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

  const INBOX_KIND_LABEL = { approval: "Approval", decision: "Decision", "post-task-decision": "After task", blocked: "Blocked", question: "Question" };

  // One Founder Inbox entry: the chief-of-staff card (rendered from the
  // backend's founder translation) wrapped with a "×" that dismisses it to the
  // "Dismissed" fold below. Dismissing is presentation-only and reversible —
  // it never resolves the decision, approves the build, or unblocks the task.
  function inboxItem(x) {
    return `<div class="inbox-entry" data-inbox-id="${esc(x.id)}">
      <button class="inbox-dismiss" data-dismiss-inbox="${esc(x.id)}" title="Dismiss from your inbox" aria-label="Dismiss from your inbox">×</button>
      ${renderFounderInboxCard(x, { esc })}
    </div>`;
  }

  // Compact row for an inbox entry the founder dismissed — shown in the
  // collapsed "Dismissed" fold with a one-click Restore.
  function dismissedInboxRow(x) {
    return `<div class="inbox-dismissed-row">
      <div><strong>${esc(x.founder?.title || x.title || INBOX_KIND_LABEL[x.kind] || x.kind)}</strong>
      <span class="muted small">${esc(x.founder?.typeLabel || INBOX_KIND_LABEL[x.kind] || x.kind)}${x.project ? ` · ${esc(x.project)}` : ""}${x.dismissedAt ? ` · dismissed ${esc(fmtTime(x.dismissedAt))}` : ""}</span></div>
      <button class="btn secondary tiny" data-restore-inbox="${esc(x.id)}">Restore</button>
    </div>`;
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
        <details class="obj-original-request"><summary>Original request</summary>
          <pre class="report-md obj-detail-prompt">${esc(o.description || o.objective || "")}</pre>
        </details>
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

  function renderExecutionView(x, thread, timeline, report = null) {
    const blocked = x.blocker || null;
    const events = (x.events || []).slice().reverse();
    // From the shared vocabulary, not a local copy: the hosted console renders
    // the same words from the same file. See control-plane/public/stage-vocabulary.mjs.
    const stageLabel = STAGE_LABEL;
    const humanStatus = { working: "working", completed: "complete", blocked: "needs attention", failed: "stopped", pending: "waiting" };
    const title = objectiveView.shortObjectiveTitle(x.title || x.objective || "Objective");
    return `<div class="operation-room"><header class="operation-header"><div><span class="eyebrow">${esc(x.project || "Factory")} · live operation</span><h2>${esc(title)}</h2><p>${esc(x.currentActivity || (blocked ? "The team is waiting for a decision." : "The team is coordinating the next move."))}</p></div><div class="operation-stat"><strong>${x.elapsedMs != null ? esc(fmtDuration(x.elapsedMs)) : "—"}</strong><span>in motion</span></div></header>
      <div class="operation-lane">${(x.stages || []).map((s, i) => `<div class="lane-step lane-${esc(s.status)}"><div class="lane-marker">${s.status === "completed" ? "✓" : s.status === "working" ? "●" : "○"}</div><div class="lane-copy"><span>${esc(humanStatus[s.status] || s.status)}</span><strong>${esc(s.agent || "Factory team")}</strong><p>${esc(s.activity || stageLabel[s.stage] || s.stage)}</p>${s.status === "working" ? `<em>Working now</em>` : ""}</div>${i < (x.stages || []).length - 1 ? `<div class="lane-connector"></div>` : ""}</div>`).join("")}</div>
      ${blocked ? `<section class="operation-callout ${blocked.autoRecovering ? "is-recovering" : ""}"><span class="eyebrow">${blocked.autoRecovering ? "Factory recovery" : blocked.needsFounder ? "Your attention" : "Needs attention"}</span><strong>${esc(blocked.headline || "The team needs your direction")}</strong><p>${esc(blocked.detail || (blocked.needsFounder ? "This is the point where the factory cannot safely decide for you." : "The team will continue when this is resolved."))}</p></section>` : ""}
      <div class="operation-grid"><section><div class="operation-section-title"><span class="eyebrow">Handoffs &amp; activity</span><h3>Watch the team work</h3></div><div class="handoff-stream">${events.length ? events.map((e) => `<div class="handoff-item"><span class="handoff-line"></span><time>${esc(fmtTime(e.at))}</time><div><strong>${esc(e.source || "Factory")}${e.destination ? ` <span>→</span> ${esc(e.destination)}` : ""}</strong><p>${esc(e.message)}</p></div></div>`).join("") : `<p class="quiet-state">The first handoff is being prepared.</p>`}</div></section><aside><div class="operation-section-title"><span class="eyebrow">Evidence</span><h3>Confidence</h3></div><div class="confidence-list"><div><strong>${(x.stages || []).filter((s) => s.status === "completed").length}</strong><span>stages complete</span></div><div><strong>${(x.evidence || []).length}</strong><span>proof artifacts</span></div><div><strong>${blocked ? "Paused" : "Protected"}</strong><span>${blocked ? "awaiting direction" : "within factory gates"}</span></div></div>${x.github?.prUrl ? `<a class="btn secondary" href="${esc(x.github.prUrl)}" target="_blank" rel="noreferrer">Open delivery ↗</a>` : ""}${report ? `<button class="btn secondary" data-open-report="${esc(report.id)}" data-open-report-kind="${esc(report.kind)}">Read the report</button>` : ""}</aside></div>${thread === undefined ? "" : interactionsSection(thread, { esc, fmtTime })}${timeline === undefined ? "" : runTimelineSection(timeline, { esc, fmtTime })}</div>`;
  }

  async function openExecutionView(id) {
    if (executionPoll) clearInterval(executionPoll);
    openModal("Task execution", `<p class="muted">Loading the durable execution record…</p>`);
    const refresh = async () => {
      try {
        const execution = await apiJson(`/api/founder/objectives/${encodeURIComponent(id)}/execution`);
        if (!modal.hidden) modalBody.innerHTML = renderExecutionView(execution, undefined, undefined, { kind: "objective", id });
        wireReportButton();
        if (execution.status !== "active" && executionPoll) { clearInterval(executionPoll); executionPoll = null; }
      } catch (e) {
        if (!modal.hidden) modalBody.innerHTML = `<p class="danger-text">${esc(e.message)}</p>`;
      }
    };
    await refresh();
    executionPoll = setInterval(refresh, 2500);
  }

  // The execution modal repaints every 2.5s while a task is active, so its
  // report button is re-bound on each paint rather than delegated once.
  function wireReportButton() {
    const btn = modalBody.querySelector("[data-open-report]");
    if (!btn) return;
    btn.onclick = () => openReportDrilldown(btn.dataset.openReportKind, btn.dataset.openReport);
  }

  function wireInteractionForm(taskId) {
    const form = modalBody.querySelector("[data-interaction-form]");
    if (!form) return;
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const field = form.querySelector("textarea");
      const body = String(field.value || "").trim();
      if (!body) return;
      const button = form.querySelector("button");
      button.disabled = true;
      try {
        await apiJson(`/api/founder/tasks/${encodeURIComponent(taskId)}/interactions`, { method: "POST", body: JSON.stringify({ body }) });
        field.value = "";
        // Re-read from the server: what is stored is redacted and normalised,
        // and echoing the submitted text would show something that is not what
        // was recorded.
        const thread = await apiJson(`/api/founder/tasks/${encodeURIComponent(taskId)}/interactions`).catch(() => null);
        const container = modalBody.querySelector(".run-interactions");
        if (container && thread) {
          container.outerHTML = interactionsSection(thread, { esc, fmtTime });
          wireInteractionForm(taskId);
        }
      } catch (error) {
        button.disabled = false;
        form.insertAdjacentHTML("afterend", `<p class="danger-text">${esc(error.message)}</p>`);
      }
    });
  }

  async function openTaskExecutionView(id) {
    if (executionPoll) clearInterval(executionPoll);
    openModal("Task execution", `<p class="muted">Loading the durable execution record…</p>`);
    const refresh = async () => {
      try {
        const [execution, thread, timeline] = await Promise.all([
          apiJson(`/api/founder/tasks/${encodeURIComponent(id)}/execution`),
          // Neither a failing thread nor a missing timeline may hide the
          // execution view: the stage lane is the founder's primary read,
          // comments are context and the timeline is depth.
          apiJson(`/api/founder/tasks/${encodeURIComponent(id)}/interactions`).catch(() => null),
          apiJson(`/api/founder/tasks/${encodeURIComponent(id)}/timeline`).catch(() => null),
        ]);
        if (!modal.hidden) modalBody.innerHTML = renderExecutionView(execution, thread, timeline, { kind: "task", id });
        wireInteractionForm(id);
        wireReportButton();
        if (execution.status !== "active" && executionPoll) { clearInterval(executionPoll); executionPoll = null; }
      } catch (e) {
        if (!modal.hidden) modalBody.innerHTML = `<p class="danger-text">${esc(e.message)}</p>`;
      }
    };
    await refresh();
    executionPoll = setInterval(refresh, 2500);
  }

  function questionStatusText(question) {
    if (question.status === "queued") return "Queued — the factory will start answering shortly…";
    if (question.status === "running") return "The factory is thinking… You can leave this open or close it and check Today later.";
    return "";
  }

  async function askFounderQuestion() {
    const questionText = document.getElementById("question-text");
    const sendButton = document.getElementById("send-question");
    const out = document.getElementById("question-answer");
    const question = questionText?.value.trim() || "";
    if (!question) return showToast("Write a question first.", true);
    sendButton.disabled = true;
    out.innerHTML = `<p class="muted">Submitting the question…</p>`;
    try {
      const created = await apiJson("/api/founder/questions", { method: "POST", body: JSON.stringify({ agentId: "main", question }) });
      const id = created.question.id;
      let terminal = false;
      const refresh = async () => {
        try {
          const current = (await apiJson(`/api/founder/questions/${encodeURIComponent(id)}`)).question;
          if (current.status === "answered") {
            terminal = true;
            out.innerHTML = `<div class="card">${esc(current.answer)}</div>`;
            sendButton.disabled = false;
            if (executionPoll) { clearInterval(executionPoll); executionPoll = null; }
          } else if (current.status === "failed") {
            terminal = true;
            out.innerHTML = `<p class="danger-text">${esc(current.error || "The factory could not answer this question.")}</p><p class="muted small">You can close this and ask again after checking Today.</p>`;
            sendButton.disabled = false;
            if (executionPoll) { clearInterval(executionPoll); executionPoll = null; }
          } else {
            out.innerHTML = `<p class="muted">${esc(questionStatusText(current))}</p>`;
          }
        } catch (error) {
          terminal = true;
          out.innerHTML = `<p class="danger-text">${esc(error.message)}</p>`;
          sendButton.disabled = false;
          if (executionPoll) { clearInterval(executionPoll); executionPoll = null; }
        }
      };
      await refresh();
      if (!terminal) executionPoll = setInterval(refresh, 2000);
    } catch (error) {
      out.innerHTML = `<p class="danger-text">${esc(error.message)}</p>`;
      sendButton.disabled = false;
    }
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
      const body = (answers = []) => JSON.stringify({ objective, projectId: project.value, ...(repo ? { repo } : {}), ...(answers.length ? { answers } : {}) });
      const launch = async (answers = []) => {
        await apiJson(endpoint, { method: "POST", body: body(answers) });
        showToast("Created. Your team is on it — follow it in “Running now” below.");
        document.getElementById("founder-objective").value = "";
        setTimeout(route, 800);
      };
      try {
        const intake = await apiJson("/api/founder/intake", { method: "POST", body: body() });
        if (!intake.questions?.length) return launch();
        const q = intake.questions[0];
        openModal("One quick question", `<p>${esc(q.question)}</p>${q.why ? `<p class="muted small">${esc(q.why)}</p>` : ""}<div class="decision-choices">${q.options.map((option) => `<button class="btn" data-intake-answer="${esc(option)}">${esc(option)}</button>`).join("")}<button class="btn secondary" data-intake-other>Other…</button></div>`);
        const answer = async (value) => { closeModal(); await launch([value]); };
        modalBody.querySelectorAll("[data-intake-answer]").forEach((btn) => btn.onclick = () => answer(btn.dataset.intakeAnswer));
        modalBody.querySelector("[data-intake-other]").onclick = () => {
          openModal("Answer the question", `<textarea class="editor" id="intake-other" placeholder="Your answer…"></textarea><button class="btn" id="intake-submit">Continue</button>`);
          document.getElementById("intake-submit").onclick = () => { const value = document.getElementById("intake-other").value.trim(); if (!value) return showToast("Write a short answer first.", true); answer(value); };
        };
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
        showToast(btn.dataset.postTask === "1" ? `Recorded: “${btn.dataset.choice}”.` : `Answered: “${btn.dataset.choice}”. Work resumed.`);
        route();
      } catch (e) { showToast(e.message, true); btn.disabled = false; }
    });
    app.querySelectorAll("[data-resolve-other]").forEach((btn) => btn.onclick = () => {
      const postTask = btn.dataset.postTask === "1";
      openModal("Choose Other", `<label class="field-label">Your answer</label><textarea class="editor" id="decision-direction" placeholder="Describe your preference…"></textarea><button class="btn" id="submit-decision">Record answer</button>`);
      document.getElementById("submit-decision").onclick = async () => {
        const dir = document.getElementById("decision-direction").value.trim();
        if (!dir) { showToast("Write a short answer first.", true); return; }
        try {
          await apiJson("/api/founder/decisions/resolve", { method: "POST", body: JSON.stringify({ statePath: btn.dataset.resolveOther, direction: dir }) });
          closeModal(); showToast(postTask ? "Recorded for the completed task." : "Decision recorded. Work resumed."); route();
        } catch (e) { showToast(e.message, true); }
      };
    });
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
    const nightProject = document.getElementById("overnight-project");
    nightProject?.addEventListener("change", () => {
      const repo = nightProject.selectedOptions[0]?.dataset.repo;
      if (repo) nightProject.dataset.repo = repo;
    });
    document.getElementById("overnight-add")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await apiJson("/api/founder/overnight/items", { method: "POST", body: JSON.stringify({ objective: document.getElementById("overnight-objective").value, projectId: nightProject.value, repo: nightProject.selectedOptions[0]?.dataset.repo }) });
        showToast("Added to tonight’s plan."); route();
      } catch (err) { showToast(err.message, true); }
    });
    app.querySelectorAll("[data-remove-night]").forEach((btn) => btn.onclick = async () => {
      try { await apiJson(`/api/founder/overnight/items/${encodeURIComponent(btn.dataset.removeNight)}`, { method: "DELETE" }); route(); }
      catch (err) { showToast(err.message, true); }
    });
    document.getElementById("start-overnight")?.addEventListener("click", async () => {
      try { await apiJson("/api/founder/overnight/start", { method: "POST" }); showToast("Overnight work started."); route(); }
      catch (err) { showToast(err.message, true); }
    });
    document.getElementById("stop-overnight")?.addEventListener("click", async () => {
      try { await apiJson("/api/founder/overnight/stop", { method: "POST" }); showToast("Stopping after the current objective."); route(); }
      catch (err) { showToast(err.message, true); }
    });
    document.getElementById("ask-agent")?.addEventListener("click", () => {
      openModal("Ask the factory", `<label class="field-label">Question</label><textarea class="editor" id="question-text" placeholder="What is blocking this work?"></textarea><button class="btn" id="send-question">Ask</button><div id="question-answer"></div>`);
      document.getElementById("send-question").onclick = askFounderQuestion;
    });
    document.getElementById("hq-search")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const box = document.getElementById("hq-search-results");
      const q = document.getElementById("hq-search-q").value;
      try {
        box.innerHTML = searchPanel(await apiJson(`/api/hq/search?q=${encodeURIComponent(q)}`), { esc, fmtTime });
      } catch (err) {
        // A rejected query is the operator's to fix, so show the reason in the
        // panel rather than a toast that disappears.
        box.innerHTML = searchPanel({ version: 1, available: false, error: err.message });
      }
    });
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
    scope.querySelectorAll(".founder-objective").forEach((card) => card.addEventListener("click", (event) => {
      if (event.target.closest("button, a")) return;
      openExecutionView(card.dataset.objectiveDetails);
    }));
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
      ${state.headquarters ? `<article class="hq-infra-card"><div><span class="eyebrow">Factory infrastructure</span><h2>${esc(state.headquarters.name)}</h2><p class="muted small">Work on the Headquarters itself using the same review, QA, security, and founder-merge gates as every project.</p></div><a class="btn secondary" href="#/project/${encodeURIComponent(state.headquarters.key)}">Open factory →</a></article>` : ""}
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

  // The Task Board, on the REAL factory pipeline.
  //
  // It used to read /api/hq -> data/hq/tasks.json, a 3-byte file, and showed
  // zero in all six columns while 21 real tasks were running. The mapping is
  // shared with the hosted console so both boards group identically.
  async function renderTasks() {
    const ops = await apiJson("/api/hq/operations").catch(() => ({ tasks: [] }));
    const project = new URLSearchParams(location.hash.split("?")[1] || "").get("project");
    const board = buildBoard(filterByProject(ops.tasks || [], project));

    app.innerHTML = `
      <div class="page-head">
        <div>
          <h1 class="page-title">Board</h1>
          <p class="muted">Where every piece of work sits right now${project ? ` · ${esc(project)}` : ""} — ${board.total} task${board.total === 1 ? "" : "s"} from the live factory.</p>
        </div>
        ${project ? `<a class="btn secondary" href="#/tasks">All projects</a>` : ""}
      </div>
      <div class="kanban">
        ${BOARD_COLUMNS.map((col) => `
          <section class="kanban-col">
            <div class="kanban-head"><span>${esc(col)}</span><b>${board.counts[col]}</b></div>
            ${board.columns[col].map(boardCard).join("") || `<p class="muted small">Nothing here.</p>`}
          </section>`).join("")}
      </div>`;

    app.querySelectorAll("[data-board-task]").forEach((el) => {
      el.addEventListener("click", () => openTaskExecutionView(el.dataset.boardTask));
    });
  }

  // A card leads with what the work is FOR. The id is small and muted, for
  // copying — never the name.
  function boardCard(card) {
    return `
      <article class="kanban-card" data-board-task="${esc(card.id)}" role="button" tabindex="0">
        <h4>${esc(card.title)}</h4>
        <div class="kanban-meta">${esc(card.outcomeLine)}</div>
        <div class="kanban-foot">
          ${card.project ? `<span class="badge badge-type">${esc(card.project)}</span>` : ""}
          ${card.assignee ? `<span class="badge">${esc(card.assignee)}</span>` : ""}
          ${card.risk === "high" ? `<span class="badge badge-warn">high risk</span>` : ""}
        </div>
        <div class="kanban-id">${esc(card.id)}</div>
      </article>`;
  }

  // What a retired page says now. It names what it used to read and why that
  // was never going to be right, and points at the surface that answers the
  // same question for real — rather than 404ing or silently redirecting.
  function renderRetired(r) {
    const page = RETIRED[r.id];
    if (!page) return renderToday();
    app.innerHTML = `
      <h1 class="page-title">${esc(page.title)} has been retired</h1>
      <p class="muted">${esc(page.why)}</p>
      ${page.instead ? `<p><a href="${esc(page.instead[0])}">${esc(page.instead[1])}</a></p>` : ""}`;
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
      else if (r.name === "retired") renderRetired(r);
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
