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

// How long a card may sit unchanged before the board says so. Three days, not
// hours: the factory legitimately takes a long time on one stage, and a board
// that cries stalled at every overnight gap is a board nobody reads. The
// number is rendered on screen, so it can never be inferred wrongly.
export const STALLED_AFTER_DAYS = 3;

// Every column except Done. A finished card is SUPPOSED to stop moving, and
// marking it stalled would turn the most reassuring thing on the board into a
// warning. Blocked is included deliberately: "blocked" and "blocked and
// forgotten for eight days" are different situations and only the second one
// is an emergency.
const NEVER_STALLED = new Set(["Done"]);

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

/**
 * How long since this task last MOVED.
 *
 * `updatedAt` is the last recorded state transition — a stage passing, a
 * dispatch failing, a blocker being set. It is NOT the last time an agent did
 * anything: a reviewer can burn an hour on a task whose state never changes.
 * Everything here says "movement" for that reason, and the view must not
 * relabel it "activity" or "last seen".
 *
 * Returns null when there is no timestamp, so a card with no movement to
 * report shows nothing rather than "moved 56 years ago".
 */
export function movement(updatedAt, { now = Date.now(), column = null } = {}) {
  const at = Date.parse(updatedAt || "");
  if (!Number.isFinite(at)) return null;
  const ms = Math.max(0, now - at);
  const days = ms / 86_400_000;
  return {
    ms,
    days: Math.floor(days),
    label: `moved ${spoken(ms)}`,
    // A column that is allowed to stall decides this, not the age alone.
    stalled: days >= STALLED_AFTER_DAYS && !NEVER_STALLED.has(column),
  };
}

function spoken(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 2) return "just now";
  if (minutes < 90) return `${minutes} minutes ago`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 36) return `${hours} hours ago`;
  const days = Math.round(ms / 86_400_000);
  return `${days} day${days === 1 ? "" : "s"} ago`;
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
export function buildBoard(tasks = [], { now = Date.now() } = {}) {
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
      // Already carried on every row and never rendered, which is how work
      // that had not moved in eight days looked identical to work that moved
      // an hour ago.
      movement: movement(task.updatedAt, { now, column }),
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
    stalled: BOARD_COLUMNS.reduce((sum, c) => sum + columns[c].filter((card) => card.movement?.stalled).length, 0),
    stalledAfterDays: STALLED_AFTER_DAYS,
  };
}

/** Narrow to what has stopped moving. Pure, so both surfaces filter alike. */
export function filterStalled(tasks = [], { now = Date.now() } = {}) {
  return (tasks || []).filter((task) => movement(task?.updatedAt, { now, column: boardColumn(task) })?.stalled);
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
