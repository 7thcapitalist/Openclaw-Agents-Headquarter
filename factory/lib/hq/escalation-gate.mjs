// "Ask the founder only when a decision changes product direction, scope,
// privacy posture, meaningful spend, external/public behavior, production data,
// or another hard-to-reverse choice." — AGENTS.md
//
// That rule was written for the agents and enforced by nothing. A stage could
// defer any question at all — `normalizeDeferredDecision` checked that it had
// text and two options, never whether it was worth a founder's attention — so
// "should the Chapter screen support editing this milestone?" reached the
// Founder Inbox with the same weight as a high-risk deployment approval. The
// founder was being paged about reversible UI scope calls the same contract
// tells agents to make themselves.
//
// This is the missing test. It does not silence anything: a decision that does
// not clear the bar is still normalized, still recorded on the task, and still
// appears in the completion report. It just does not page the founder.
//
// The vocabulary is not invented here. It is the trigger set the factory
// already uses to classify decisions at intake (factory/decision-protocol.json,
// machine form of factory/context/DECISION_PROTOCOL.md), so a question that
// would have stopped intake is exactly the question that may reach the inbox
// after the work is done.

import { DEFAULT_PROTOCOL } from "../intel/classify.mjs";

/**
 * The impacts that are the founder's to own. Derived from the decision
 * protocol's own triggers so the two can never drift: privacy, spend, public,
 * product-direction, scope, irreversible, security-posture, legal.
 */
export const FOUNDER_IMPACTS = Object.freeze(
  new Set((DEFAULT_PROTOCOL.triggers || []).map((trigger) => String(trigger.id))),
);

/**
 * Should this deferred decision reach the founder?
 *
 * A stage must say WHICH founder-owned impact its question carries, in the
 * protocol's own vocabulary. Anything else — an unclassified question, or one
 * classified as something the protocol does not consider founder-owned — is a
 * decision the agent was contracted to make itself.
 *
 * Silence means "decide it yourself". That is deliberate: an escalation is a
 * claim on the founder's attention, and a claim has to be justified rather than
 * assumed. It is also the safe direction to be wrong in — an unescalated
 * decision is recorded, visible on the task, and in the completion report,
 * while an over-escalated one costs attention that is gone for good.
 *
 * @param {object} input the decision as the stage reported it
 * @returns {{escalate: boolean, impact: string|null, reason: string}}
 */
export function escalationVerdict(input) {
  const declared = String(input?.impact || "").trim().toLowerCase();
  if (!declared) {
    return {
      escalate: false,
      impact: null,
      reason: "No founder-owned impact was declared, so this is the agent's own call to make.",
    };
  }
  if (!FOUNDER_IMPACTS.has(declared)) {
    return {
      escalate: false,
      impact: declared,
      reason: `"${declared}" is not a founder-owned impact (${[...FOUNDER_IMPACTS].join(", ")}), so this is the agent's own call to make.`,
    };
  }
  return { escalate: true, impact: declared, reason: `Declared ${declared} impact, which is founder-owned.` };
}
