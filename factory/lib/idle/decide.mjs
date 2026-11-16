export const IDLE_TRIGGER_DEFAULTS = Object.freeze({
  mode: "on",
  maxLaunchesPerDay: 4,
  heartbeatMinutes: 15,
  shortWindowReservePct: 40,
  weeklyReservePct: 20,
  expiringHorizonHours: 24,
  maxOpenPrs: 3,
});

const ACTIVE = new Set(["starting", "decomposing", "planned", "active", "running", "recovering", "incomplete", "integration-blocked", "yielded"]);
const ACTIONABLE_FINDING_KINDS = new Set(["failure", "pattern", "agent-improvement"]);
const HIGH_RISK = /security|secret|credential|permission|approval|gate|state machine|workflow engine|auto.?merge|deploy|production|billing|payment|privacy/i;

export function idleTriggerConfig(config = {}) {
  const raw = config?.learning?.idleTrigger || {};
  const mode = ["off", "shadow", "on"].includes(raw.mode) ? raw.mode : IDLE_TRIGGER_DEFAULTS.mode;
  return { ...IDLE_TRIGGER_DEFAULTS, ...raw, mode };
}

export function resetDurationHours(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  let hours = 0;
  let matched = false;
  for (const match of value.matchAll(/(\d+(?:\.\d+)?)\s*(d|day|days|h|hr|hrs|hour|hours|m|min|mins|minute|minutes)\b/gi)) {
    matched = true;
    const n = Number(match[1]);
    const unit = match[2].toLowerCase();
    hours += unit.startsWith("d") ? n * 24 : unit.startsWith("h") ? n : n / 60;
  }
  return matched ? hours : null;
}

function containsFinding(value, id) {
  return String(value || "").toLowerCase().includes(String(id || "").toLowerCase());
}

function findingRisk(finding) {
  if (["low", "medium", "high"].includes(finding?.risk)) return finding.risk;
  const text = [finding?.kind, finding?.title, finding?.observation, finding?.recommendation].join(" ");
  return HIGH_RISK.test(text) ? "high" : "medium";
}

export function evaluateFinding(finding, { patternThreshold = 2, objectives = [], openPrs = [], evidenceExists = () => true } = {}) {
  if (!ACTIONABLE_FINDING_KINDS.has(finding?.kind)) return { eligible: false, reason: "non-actionable-kind" };
  if (!finding || finding.status !== "open" || Number(finding.occurrences || 0) < patternThreshold) return { eligible: false, reason: "below-threshold" };
  if (!Array.isArray(finding.evidence) || finding.evidence.length === 0) return { eligible: false, reason: "missing-evidence" };
  if (!finding.evidence.every((entry) => evidenceExists(typeof entry === "string" ? entry : entry?.path))) return { eligible: false, reason: "missing-evidence" };
  const addressed = objectives.some((objective) => ACTIVE.has(objective?.status) && containsFinding(objective?.objective || objective?.text || objective?.title, finding.id))
    || openPrs.some((pr) => containsFinding(`${pr?.title || ""} ${pr?.headRefName || pr?.branch || ""}`, finding.id));
  if (addressed) return { eligible: false, reason: "already-addressed" };
  return { eligible: true, reason: null, risk: findingRisk(finding) };
}

export function decideIdleLaunch({ config = {}, now = new Date().toISOString(), objectives = [], founderQueued = false, headroom = [], findings = [], openPrs = [], launchesToday = 0, evidenceExists } = {}) {
  const settings = idleTriggerConfig(config);
  const founderActive = objectives.some((objective) => objective?.origin !== "learning-agent" && ACTIVE.has(objective?.status));
  if (founderActive) return skip("founder-active", settings);
  if (founderQueued) return skip("founder-queued", settings);
  const unknown = headroom.some((seat) => seat?.status !== "available" || !Number.isFinite(seat?.shortWindow?.percentLeft) || !Number.isFinite(seat?.weekWindow?.percentLeft));
  if (!headroom.length || unknown) return skip("seat-unknown", settings);
  if (headroom.some((seat) => seat.shortWindow.percentLeft < settings.shortWindowReservePct)) return skip("short-window-low", settings);
  if (headroom.some((seat) => seat.weekWindow.percentLeft < settings.weeklyReservePct)) return skip("weekly-low", settings);
  const expiring = headroom.every((seat) => seat.weekWindow.percentLeft > settings.weeklyReservePct
    && resetDurationHours(seat.weekWindow.resetIn) !== null
    && resetDurationHours(seat.weekWindow.resetIn) <= settings.expiringHorizonHours);
  if (!expiring) return skip("no-expiring-surplus", settings);
  if (objectives.some((objective) => objective?.origin === "learning-agent" && ACTIVE.has(objective?.status))) return skip("self-improvement-running", settings);
  const learningPrs = openPrs.filter((pr) => pr?.origin === "learning-agent" || /learning-agent|self-improvement|factory\/learning-/i.test(`${pr?.title || ""} ${pr?.headRefName || ""}`));
  if (learningPrs.length >= settings.maxOpenPrs) return skip("open-pr-cap", settings);
  if (launchesToday >= settings.maxLaunchesPerDay) return skip("daily-cap", settings);

  const evaluated = findings.map((finding) => ({ finding, ...evaluateFinding(finding, { patternThreshold: config?.learning?.patternThreshold || 2, objectives, openPrs, evidenceExists }) }));
  const candidate = evaluated.filter((item) => item.eligible).sort((a, b) => Number(b.finding.occurrences || 0) - Number(a.finding.occurrences || 0) || String(a.finding.id).localeCompare(String(b.finding.id)))[0];
  if (!candidate) return skip("no-eligible-finding", settings, evaluated.map(({ finding, reason }) => ({ findingId: finding?.id, reason })));
  const reasons = ["factory-idle", "credit-headroom-available", "weekly-credit-expiring", `finding:${candidate.finding.id}`];
  return { action: candidate.risk === "high" ? "propose" : "launch", idleReason: null, reasons, finding: candidate.finding, risk: candidate.risk, settings };
}

function skip(idleReason, settings, findings = []) {
  return { action: "skip", idleReason, reasons: [idleReason], finding: null, findings, settings };
}
