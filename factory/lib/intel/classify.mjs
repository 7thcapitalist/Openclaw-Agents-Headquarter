import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";

// Embedded copy so classification works even without the JSON file on disk.
// factory/decision-protocol.json is the authoritative, editable form.
export const DEFAULT_PROTOCOL = {
  version: 1,
  defaultOutcome: "continue",
  triggers: [
    {
      id: "privacy",
      outcome: "decision-request",
      anyKeyword: [
        "personal data", "health data", "pii", "data retention", "retention policy",
        "consent", "encryption at rest", "gdpr", "hipaa", "store user data",
      ],
      reason: "Privacy / data-retention posture is a founder call.",
    },
    {
      id: "spend",
      outcome: "decision-request",
      anyKeyword: [
        "paid plan", "subscription", "per-seat", "add a vendor", "usage billing",
        "recurring cost", "license fee", "upgrade the plan", "paid tier",
      ],
      reason: "Recurring or meaningful spend requires founder approval.",
    },
    {
      id: "public",
      outcome: "decision-request",
      anyKeyword: [
        "publish", "press release", "public announcement", "app store submission",
        "changelog to users", "marketing site", "post publicly", "launch announcement",
      ],
      reason: "External communication is founder-owned.",
    },
    {
      id: "product-direction",
      outcome: "decision-request",
      anyKeyword: [
        "target user", "pivot", "business model", "pricing model",
        "core value proposition", "change the product promise",
      ],
      reason: "Product direction and target user are founder-owned.",
    },
    {
      id: "scope",
      outcome: "decision-request",
      anyField: { changesMilestonePriority: true },
      reason: "Re-prioritising the roadmap is a founder call.",
    },
    {
      id: "irreversible",
      outcome: "decision-request",
      anyKeyword: [
        "drop table", "delete production", "production data deletion",
        "destructive migration", "rename public api", "break backwards compatibility",
        "irreversible migration",
      ],
      reason: "Hard-to-reverse change.",
    },
    {
      id: "security-posture",
      outcome: "decision-request",
      anyKeyword: [
        "auth model", "authentication model", "permission model", "secret rotation",
        "access control policy", "security posture",
      ],
      reason: "Security posture is a founder call.",
    },
    {
      id: "legal",
      outcome: "decision-request",
      anyKeyword: ["legal review", "compliance", "terms of service", "privacy policy", "licensing terms"],
      reason: "Legal / compliance implications need the founder.",
    },
  ],
  riskBinding: { high: "decision-request" },
  sla: { decisionRequestReminderHours: 24, blockingQuestionTimeoutHours: 4 },
};

export function loadDecisionProtocol(hqRoot) {
  const path = join(resolve(hqRoot), "factory", "decision-protocol.json");
  if (!existsSync(path)) return DEFAULT_PROTOCOL;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.triggers)) return DEFAULT_PROTOCOL;
    return parsed;
  } catch {
    return DEFAULT_PROTOCOL;
  }
}

/**
 * Classify one judgement call.
 *
 * @param {object}  input
 * @param {string} [input.text]     free text describing the task or proposed change
 * @param {object} [input.fields]   structured signals: { risk, changesMilestonePriority,
 *                                  blocksAllProgress, ... }
 * @param {object} [input.protocol] a protocol object; defaults to DEFAULT_PROTOCOL
 * @returns {{ outcome: "continue"|"decision-request"|"ask", reason: string, trigger: string|null }}
 */
export function classifyDecision({ text = "", fields = {}, protocol = DEFAULT_PROTOCOL } = {}) {
  const proto = protocol && Array.isArray(protocol.triggers) ? protocol : DEFAULT_PROTOCOL;
  const haystack = String(text || "").toLowerCase();

  // High-risk tasks are always a founder decision (mirrors the engine's
  // signed-approval-before-build gate).
  const riskOutcome = proto.riskBinding?.[fields.risk];
  if (riskOutcome === "decision-request") {
    return { outcome: "decision-request", reason: "High-risk work requires founder approval before the risky action.", trigger: "risk:high" };
  }

  for (const trigger of proto.triggers) {
    if (Array.isArray(trigger.anyKeyword) &&
      trigger.anyKeyword.some((kw) => haystack.includes(String(kw).toLowerCase()))) {
      return { outcome: trigger.outcome || "decision-request", reason: trigger.reason || `Matched ${trigger.id}.`, trigger: trigger.id };
    }
    if (trigger.anyField && typeof trigger.anyField === "object") {
      const matched = Object.entries(trigger.anyField).every(([key, want]) => fields[key] === want);
      if (matched) {
        return { outcome: trigger.outcome || "decision-request", reason: trigger.reason || `Matched ${trigger.id}.`, trigger: trigger.id };
      }
    }
  }

  if (fields.blocksAllProgress === true) {
    return { outcome: "ask", reason: "The task cannot make any safe progress until one factual clarification is answered.", trigger: "blocking" };
  }

  return { outcome: proto.defaultOutcome || "continue", reason: "Reversible, in declared scope, no policy trigger hit.", trigger: null };
}
