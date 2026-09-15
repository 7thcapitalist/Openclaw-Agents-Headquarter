// The "Task execution" view, ported from the local dashboard.
//
// Leads with the outcome in plain language, then the project and how long the
// work has been in motion, then the seven stages each with the agent that did
// it and a plain-language label, then the handoff timeline and the evidence.
// Same shape as the local modal; different data source.

import { stageLabel, stageStatusLabel, taskTitle, taskOutcomeLine } from "./stage-vocabulary.mjs";
import { money } from "./render.mjs";

function el(tag, className, textContent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textContent != null) node.textContent = String(textContent);
  return node;
}

function duration(fromIso, toIso) {
  const a = Date.parse(fromIso || ""), b = Date.parse(toIso || "") || Date.now();
  if (Number.isNaN(a)) return null;
  const s = Math.max(0, Math.round((b - a) / 1000));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172_800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

const MARK = { pass: "✓", completed: "✓", fail: "✕", failed: "✕", "decision-required": "!", blocked: "!", pending: "○" };

/** Draw one task's execution record into `root`. */
export function renderTaskDetail(root, detail) {
  root.replaceChildren();
  if (!detail) {
    root.append(el("p", "home-calm", "No detail has been published for this task yet."));
    return;
  }

  const title = taskTitle({ outcome: detail.objective, taskId: detail.taskId });
  const head = el("header", "task-head");
  head.append(el("span", "eyebrow", `${detail.projectId || "Factory"} · execution record`));
  head.append(el("h2", null, title));
  head.append(el("p", "home-meta", taskOutcomeLine({ status: detail.status, stage: detail.currentStage })));
  const inMotion = duration(detail.createdAt, detail.updatedAt);
  if (inMotion) head.append(el("p", "home-meta home-meta--dim", `${inMotion} in motion`));
  root.append(head);

  // Blocked, up front, in the founder's words.
  if (detail.blocker) {
    const callout = el("section", "task-callout");
    callout.append(el("span", "eyebrow", detail.blocker.founderAction ? "Your attention" : "Needs attention"));
    callout.append(el("strong", null, detail.blocker.whatFailed || "The team needs direction"));
    if (detail.blocker.why) callout.append(el("p", null, String(detail.blocker.why).slice(0, 400)));
    root.append(callout);
  }

  // The seven stages.
  root.append(el("h3", "task-section", "The seven stages"));
  const lane = el("ol", "task-lane");
  for (const stage of detail.stages || []) {
    const item = el("li", `task-step task-step--${stage.status}`);
    item.append(el("span", "task-mark", MARK[stage.status] || "○"));
    const body = el("div", "task-step-body");
    body.append(el("div", "task-step-name", stageLabel(stage.stage)));
    const bits = [stageStatusLabel(stage.status)];
    if (stage.agent) bits.push(stage.agent);
    if (stage.attempts) bits.push(`${stage.attempts} of ${stage.maxAttempts} attempts`);
    body.append(el("div", "home-meta", bits.join(" · ")));
    if (stage.summary) body.append(el("p", "task-summary", String(stage.summary).slice(0, 300)));
    for (const failure of stage.failures || []) {
      const f = el("p", "task-failure");
      f.append(el("strong", null, "Why it stopped: "));
      f.append(document.createTextNode(String(failure.error || "").slice(0, 600)));
      body.append(f);
    }
    if (stage.evidence?.length) {
      const ev = el("div", "task-evidence");
      ev.append(el("span", "home-meta", `${stage.evidence.length} proof artifact${stage.evidence.length === 1 ? "" : "s"}: `));
      ev.append(el("code", null, stage.evidence.join("  ")));
      body.append(ev);
    }
    item.append(body);
    lane.append(item);
  }
  root.append(lane);

  // Recovery, when the factory tried to repair itself.
  if (detail.recovery?.attempts?.length) {
    root.append(el("h3", "task-section", "What the factory tried"));
    const list = el("ul", "home-list");
    for (const attempt of detail.recovery.attempts) {
      const row = el("li", "home-row");
      row.append(el("span", `home-dot home-dot--${attempt.status === "verified" ? "good" : "warn"}`));
      const body = el("div", "home-row-body");
      body.append(el("div", "home-row-title", `${attempt.strategy || "recovery"} — ${attempt.status || "unknown"}`));
      if (attempt.error) body.append(el("div", "home-meta", String(attempt.error).slice(0, 220)));
      row.append(body);
      list.append(row);
    }
    root.append(list);
  }

  // What it produced.
  const foot = el("div", "task-foot");
  if (detail.cost?.costMicros != null) foot.append(el("span", "stat-chip", `${money(detail.cost.costMicros)} spent`));
  if (detail.branch) foot.append(el("span", "stat-chip", detail.branch));
  root.append(foot);

  const links = el("div", "home-links");
  if (detail.prUrl) links.append(link(detail.prUrl, "Open the pull request ↗"));
  if (detail.previewUrl) links.append(link(detail.previewUrl, "Open the preview ↗"));
  if (!detail.prUrl && !detail.previewUrl) {
    links.append(el("span", "home-meta", "No pull request or preview has been recorded for this task."));
  }
  root.append(links);
  root.append(el("p", "home-id", detail.taskId));
}

function link(href, label) {
  const a = el("a", "home-link", label);
  a.href = href; a.target = "_blank"; a.rel = "noreferrer";
  return a;
}
