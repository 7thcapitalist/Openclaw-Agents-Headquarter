// Budget policies are founder intent, so they are tracked in Git at
// `factory/budgets.json` and change through a reviewed pull request — the same
// reasoning as `factory/goals.json`. There is no runtime write path, and no
// route that can raise a limit without review.

import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { evaluateBudgetAlerts } from "./budget-alerts.mjs";

const MAX_POLICIES = 200;

export function readPolicyRegistry(hqRoot, { path = null } = {}) {
  const file = path || join(resolve(hqRoot), "factory", "budgets.json");
  if (!existsSync(file)) return { version: 1, policies: [], present: false, path: file };

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`budget registry at ${file} is not valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.policies)) {
    throw new Error(`budget registry at ${file} must be an object with a 'policies' array`);
  }
  if (parsed.policies.length > MAX_POLICIES) {
    throw new Error(`budget registry holds more than ${MAX_POLICIES} policies`);
  }

  const seen = new Set();
  for (const policy of parsed.policies) {
    if (seen.has(policy?.id)) throw new Error(`duplicate budget policy '${policy.id}'`);
    seen.add(policy?.id);
  }
  // Validate by evaluating against an empty ledger: the evaluator owns the
  // policy schema, so there is exactly one definition of a valid policy.
  evaluateBudgetAlerts({ policies: parsed.policies, events: [] });

  return { version: 1, policies: parsed.policies, present: true, path: file };
}
