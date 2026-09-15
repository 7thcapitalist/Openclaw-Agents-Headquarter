// Executing founder intents that arrived from the internet.
//
// `intent-protocol.mjs` states the rule this module exists to obey:
//
//     AN INTENT IDENTIFIES AN ACTION. IT NEVER CARRIES A COMMAND.
//
// That module validates and records and is asserted by test to execute nothing.
// This is the half it deliberately omits — the mapping from `kind` to a local
// handler — and it lives apart from the protocol on purpose, so that the
// protocol file cannot be edited into a dispatcher.
//
// Three properties hold this shut, and each is a test rather than a convention:
//
//   1. THE MAP IS CLOSED AND STATIC. Handlers are registered by the caller from
//      a literal object. No kind is ever resolved from the intent itself — no
//      `handlers[intent.kind]` against an attacker-supplied key without first
//      proving that key is in the allowlist, no dynamic import, no path built
//      from an argument. A queue fed from the internet that could name its own
//      handler would be remote code execution on a home machine.
//
//   2. VALIDATION HAPPENS HERE, AFTER CLAIMING. The control plane checks shape
//      and size only; it does not know the allowlist and must not. Everything
//      claimed is re-validated against `validateIntent` before a handler sees
//      it, because the machine never trusts the network — not even a control
//      plane it published to itself.
//
//   3. NOTHING ESCALATES. An intent can only ask for something the founder
//      could already do in the local dashboard. `prohibitedAutonomousActions`
//      and the signed founder-approval gate are unchanged and still apply on
//      execution. An intent is a request to run a gate, never a way around one.

import { isKnownIntentKind, validateIntent } from "../integrations/intent-protocol.mjs";

/**
 * Execute one claimed intent.
 *
 * Returns { status, detail } and never throws: this runs in a poll loop on the
 * founder's machine, and an unhandled rejection there stops the loop silently —
 * which looks exactly like a healthy worker with nothing to do.
 *
 * @param {object}  intent    the claimed record
 * @param {object}  handlers  literal map of kind -> async (args) => detail
 */
export async function executeIntent(intent, handlers = {}) {
  // Re-validate everything, whatever the control plane said about it.
  const verdict = validateIntent(intent);
  if (!verdict.ok) {
    return { status: "rejected", detail: `invalid intent: ${verdict.reason}` };
  }

  // Prove the kind is in the allowlist BEFORE it is used to look anything up.
  // The order matters: indexing a map with an unvetted key is the bug this
  // whole module is arranged to prevent.
  if (!isKnownIntentKind(intent.kind)) {
    return { status: "rejected", detail: `unknown intent kind` };
  }

  // `hasOwnProperty`, not `in` and not plain indexing: a kind of "constructor"
  // or "__proto__" would otherwise resolve to a function from the prototype
  // chain and be called. The allowlist check above already excludes those, and
  // this is the second lock on the same door.
  if (!Object.prototype.hasOwnProperty.call(handlers, intent.kind)) {
    // `rejected`, not `failed`. The two mean different things to a reader: this
    // machine did not try and fail, it will not do this at all — twelve kinds
    // are allowlisted and only some are wired. A console that offers an
    // unhandled kind must show the founder why nothing happened rather than
    // leaving a request that dies quietly.
    return {
      status: "rejected",
      detail: `"${intent.kind}" is allowlisted but not handled on this machine — nothing was run. `
        + "It has to be wired in scripts/hq-intents.mjs before the button can work.",
    };
  }

  const handler = handlers[intent.kind];
  if (typeof handler !== "function") {
    return { status: "failed", detail: `handler for ${intent.kind} is not callable` };
  }

  try {
    const detail = await handler(intent.args || {}, intent);
    return { status: "done", detail: detail === undefined ? null : String(detail).slice(0, 2000) };
  } catch (error) {
    // The message may carry a path or an internal detail; bound it and let the
    // caller decide what reaches the network.
    return { status: "failed", detail: String(error?.message || error).slice(0, 500) };
  }
}

/**
 * Execute a batch, in order, one at a time.
 *
 * Sequential on purpose: two intents can touch the same task, and running them
 * concurrently would make the outcome depend on which finished first. The
 * founder issued them in an order; honour it.
 */
export async function executeBatch(intents, handlers = {}, { onResult = null } = {}) {
  const results = [];
  for (const intent of intents || []) {
    const result = await executeIntent(intent, handlers);
    results.push({ id: intent?.id ?? null, ...result });
    if (onResult) {
      try {
        await onResult(intent, result);
      } catch {
        // Reporting a result must never lose the rest of the batch.
      }
    }
  }
  return results;
}
