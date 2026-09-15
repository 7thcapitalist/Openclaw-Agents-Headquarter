// Classify a task contract at intake, however the task was created.
//
// This used to run only on the natural-language intake path, so of the 21 tasks
// in the state root exactly ONE carried a classification. Every
// objective-decomposed node — which is how almost all real work enters this
// factory, including every LifeMax node — was never classified at all. The
// blocking-by-default rule shipped in #223 was therefore correct and almost
// entirely unreachable.
//
// The rule itself is unchanged and lives here now so both callers share one
// definition rather than drifting apart:
//   - blocking by default; an unset `advisory` flag is not consent
//   - a LOW-risk task whose matched rule explicitly opted out may be advisory
//   - risk HIGH is never advisory, whatever any rule says

import { classifyDecision, loadDecisionProtocol } from "../intel/classify.mjs";

export const SURFACED_OUTCOMES = new Set(["decision-request", "ask", "block"]);

/** The text a contract offers a keyword classifier. */
export function classifiableText(contract) {
  return [contract?.outcome, ...(Array.isArray(contract?.acceptanceCriteria) ? contract.acceptanceCriteria : [])]
    .filter((part) => typeof part === "string" && part.trim())
    .join("\n");
}

export function isAdvisoryOnly(classification, contract, protocol) {
  if (contract?.risk === "high") return false;
  if (classification?.trigger === "risk:high") return false;
  if (contract?.risk !== "low") return false;
  const rule = (protocol?.triggers || []).find((t) => t.id === classification?.trigger);
  return rule?.advisory === true;
}

export function findMatchedRule(classification, protocol) {
  if (classification?.trigger === "risk:high") {
    return { id: "risk:high", outcome: "decision-request", reason: classification.reason, source: "riskBinding" };
  }
  const rule = (protocol?.triggers || []).find((t) => t.id === classification?.trigger);
  return rule ? { id: rule.id, outcome: rule.outcome || "decision-request", reason: rule.reason || null, source: "trigger" } : null;
}

/**
 * Classify one contract. Returns the `advisory` namespace to attach, or null
 * when nothing was surfaced.
 *
 * Never throws: a classifier failure must not stop a task being created. An
 * unclassified task is the status quo ante; a task that cannot be created at
 * all is worse.
 */
export function classifyTaskContract({ contract, hqRoot, protocol = null, text = null, now = () => new Date().toISOString() } = {}) {
  try {
    const decisionProtocol = protocol || loadDecisionProtocol(hqRoot);
    const classification = classifyDecision({
      text: text || classifiableText(contract),
      fields: { risk: contract?.risk, workType: contract?.workType },
      protocol: decisionProtocol,
    });

    const boundRisk = contract?.risk === "high" ? decisionProtocol.riskBinding?.high : null;
    if (boundRisk && classification.outcome === "continue") {
      classification.outcome = "decision-request";
      classification.reason = `High-risk work requires ${boundRisk}.`;
      classification.trigger = "risk:high";
    }
    if (!SURFACED_OUTCOMES.has(classification.outcome)) return null;

    const advisoryOnly = isAdvisoryOnly(classification, contract, decisionProtocol);
    return {
      decisionClassification: {
        advisory: advisoryOnly,
        blocksDispatch: !advisoryOnly,
        label: advisoryOnly
          ? "ADVISORY — low-risk work whose matched rule opted out of blocking; does not block dispatch."
          : "BLOCKING — the founder is asked before this task dispatches.",
        outcome: classification.outcome,
        surfacedAs: classification.outcome === "block" ? "decision-request" : classification.outcome,
        trigger: classification.trigger,
        reason: classification.reason,
        matchedRule: findMatchedRule(classification, decisionProtocol),
        protocolVersion: decisionProtocol.version,
        classifier: "factory/lib/intel/classify.mjs",
        classifiedAt: now(),
      },
    };
  } catch {
    return null;
  }
}
