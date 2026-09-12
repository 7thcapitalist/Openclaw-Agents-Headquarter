// Stable identifiers for acceptance criteria (FCT-P0-05, requirement 4).
//
// Acceptance criteria are free text in the task contract. To require that every
// criterion is proven, each one needs an identity that:
//
//   - is stable across attempts, dispatches, and stages, so a proof recorded by
//     the builder still refers to the same criterion when QA reads it;
//   - is derived from the criterion's TEXT, not its position, so reordering the
//     list does not silently re-point existing proofs at different criteria;
//   - CHANGES when the text changes, so editing a criterion invalidates proofs
//     that were made against the old wording rather than inheriting them.
//
// That last property is the point. An ID that survived an edit would let a
// criterion be quietly rewritten after it was proven.

import { createHash } from "node:crypto";

// Normalize before hashing so trivial reformatting (wrapping, trailing
// whitespace, case) does not churn IDs, while a real wording change does.
function normalizeCriterionText(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function criterionId(text) {
  const normalized = normalizeCriterionText(text);
  if (!normalized) throw new Error("An acceptance criterion cannot be empty.");
  return `AC-${createHash("sha256").update(normalized).digest("hex").slice(0, 10)}`;
}

// Assign IDs to a task contract's criteria.
//
// Two criteria with identical text would collide; rather than silently merging
// them (which would let one proof satisfy both) each duplicate gets an explicit
// ordinal suffix so they stay distinct.
export function assignCriterionIds(acceptanceCriteria) {
  const list = Array.isArray(acceptanceCriteria) ? acceptanceCriteria : [];
  const seen = new Map();
  return list.map((text, index) => {
    const base = criterionId(text);
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    return {
      id: count === 1 ? base : `${base}#${count}`,
      index,
      text: String(text).trim(),
    };
  });
}

// Look up the criteria for a task state, deriving them on demand. Nothing is
// persisted here: the IDs are a pure function of the contract, so they cannot
// drift out of sync with it.
export function criteriaForState(state) {
  return assignCriterionIds(state?.task?.acceptanceCriteria);
}

export function criterionIdSet(state) {
  return new Set(criteriaForState(state).map((c) => c.id));
}

// Which criteria a stage is expected to speak to.
//
// Only the verification stages are asked to prove acceptance criteria. Product
// and architect produce design evidence, and the builder's own claim is not
// independent, so requiring a proof mapping from them would turn this into
// paperwork rather than verification.
const PROVING_STAGES = new Set(["qa", "security", "reviewer"]);

export function stageMustProveCriteria(stage) {
  return PROVING_STAGES.has(String(stage));
}
