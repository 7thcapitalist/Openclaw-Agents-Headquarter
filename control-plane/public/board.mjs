// Where every piece of work sits. ONE mapping, both surfaces.
//
// The local Task Board read dashboard/backend/data/hq/tasks.json — a 3-byte
// file — and showed zero in all six columns while 21 real tasks were running.
// The hosted console had no board at all. This is the mapping both now use.

import { STAGES, stageLabel, taskTitle, taskOutcomeLine } from "./stage-vocabulary.mjs";

export const BOARD_COLUMNS = Object.freeze(["Inbox", "Assigned", "In Progress", "Review", "Done", "Blocked"]);

// The three gates are one gate to the founder. Splitting reviewer, qa and
// security into three columns would make the board unreadable and would not
// tell them anything they act on differently — all three mean "built, being
// checked".
const REVIEW_STAGES = new Set(["reviewer", "qa", "security"]);
const ASSIGNED_STAGES = new Set(["product", "architect"]);
const DONE_STATUS = new Set(["merge-ready", "merged", "complete", "completed"]);

/**
 * Which column a task belongs in.
 *
 * Blocked outranks stage: a task stuck at Quality check is Blocked, not Review,
 * because the founder acts on "stuck" and not on "where it stopped".
 */
export function boardColumn(task) {
  const status = String(task?.status || "").toLowerCase();
  if (status === "blocked" || status === "failed") return "Blocked";
  if (DONE_STATUS.has(status)) return "Done";

  const stage = task?.stage || null;
  if (!stage) return "Inbox";
  if (REVIEW_STAGES.has(stage)) return "Review";
  if (stage === "builder") return "In Progress";
  if (ASSIGNED_STAGES.has(stage)) return "Assigned";
  if (stage === "release") return "In Progress";
  return "Inbox";
}

/** How far through the seven stages this task is, for a progress hint. */
export function stagePosition(stage) {
  const index = STAGES.indexOf(stage);
  return index < 0 ? null : { index: index + 1, total: STAGES.length, label: stageLabel(stage) };
}

/**
 * The board, grouped and ordered. Pure: takes published task rows, returns what
 * a view draws, so both surfaces group identically.
 */
export function buildBoard(tasks = []) {
  const columns = Object.fromEntries(BOARD_COLUMNS.map((c) => [c, []]));
  for (const task of tasks || []) {
    if (!task?.taskId) continue;
    const column = boardColumn(task);
    columns[column].push({
      id: task.taskId,
      title: taskTitle({ outcome: task.outcome, taskId: task.taskId }),
      project: task.projectId || null,
      status: task.status || "unknown",
      stage: task.stage || null,
      stagePosition: stagePosition(task.stage),
      // Never "failed at —". And never "Shaping the outcome · Shaping the
      // outcome 1/7": for a task in flight the outcome line IS the stage name,
      // so the card shows the position instead of saying it twice.
      outcomeLine: lineFor(task),
      assignee: task.assignee || null,
      risk: task.risk || null,
      updatedAt: task.updatedAt || null,
      prUrl: task.prUrl || null,
    });
  }
  // Newest movement first inside a column: what changed most recently is what
  // the founder is most likely to be looking for.
  for (const column of BOARD_COLUMNS) {
    columns[column].sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  }
  return {
    columns,
    counts: Object.fromEntries(BOARD_COLUMNS.map((c) => [c, columns[c].length])),
    total: (tasks || []).filter((t) => t?.taskId).length,
  };
}

// One line for what is happening, without repeating itself.
function lineFor(task) {
  const line = taskOutcomeLine({ status: task.status, stage: task.stage });
  const position = stagePosition(task.stage);
  if (!position) return line;
  // The line often already names the stage — "Blocked at preparing delivery" —
  // so appending "Preparing delivery 7/7" says it twice. Append only the
  // position when the words are already there.
  if (line.toLowerCase().includes(position.label.toLowerCase())) {
    return `${line} ${position.index}/${position.total}`;
  }
  return `${line} · ${position.label} ${position.index}/${position.total}`;
}

/** Optionally narrow to one project, for the Projects click-through. */
export function filterByProject(tasks = [], projectId = null) {
  if (!projectId) return tasks;
  return (tasks || []).filter((t) => t?.projectId === projectId);
}
