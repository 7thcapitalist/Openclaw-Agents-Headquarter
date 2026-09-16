// The shipped registry is load-bearing in a way the example file never was.
//
// `initializeTask` refuses to create a task at all when the registry is
// unreadable ("permission registry is unreadable, refusing to initialize"), so
// a malformed `factory/permissions.json` does not degrade the factory — it
// stops it. Now that the file is real and not an example, that risk is real,
// and this is the guard: the committed registry must parse, validate, and stay
// in the mode it claims.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

import { CAPABILITIES, authorize, readPermissionRegistry } from "../lib/hq/permissions.mjs";
import { defaultAssignments } from "../lib/task-workflow.mjs";

const HQ_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const registry = () => readPermissionRegistry(HQ_ROOT);

test("the committed registry loads and validates", () => {
  // readPermissionRegistry throws on any invalid grant, unknown capability, or
  // forbidden capability. Reaching this line at all is most of the assertion.
  const loaded = registry();
  assert.ok(loaded.grants.length > 0, "a registry with no grants would deny everything under enforce");
  for (const grant of loaded.grants) {
    assert.ok(CAPABILITIES.includes(grant.capability), `${grant.capability} is not in the capability vocabulary`);
  }
});

test("the committed registry is in report mode — enforcing is a separate, deliberate change", () => {
  assert.equal(registry().enforcement, "report");
  // Belt and braces: the file itself must say so, so a reader of the JSON is
  // not relying on a default to know that denials are not yet real.
  const raw = JSON.parse(readFileSync(join(HQ_ROOT, "factory", "permissions.json"), "utf8"));
  assert.equal(raw.mode, "report");
});

test("the actor the factory actually passes is granted, so report mode measures policy and not attribution", () => {
  // task-initializer.mjs sends actorId "openclaw-factory" when no explicit
  // actor is supplied — which is every call today. Without a grant for it the
  // audit log would read "everything would be denied", which says nothing about
  // whether the grant table is right.
  const decision = authorize({
    registry: registry(),
    actorType: "agent",
    actorId: "openclaw-factory",
    capability: "task.initialize",
    scope: { type: "task", id: "task-probe", projectId: "lifemaxing" },
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.wouldDeny, false);
  assert.equal(decision.reason, "granted");
});

test("report mode still allows an ungranted actor, and still records that it would not have", () => {
  const decision = authorize({
    registry: registry(),
    actorType: "agent",
    actorId: "an-agent-nobody-granted",
    capability: "task.initialize",
    scope: { type: "task", id: "task-probe" },
  });
  assert.equal(decision.allowed, true, "report mode must never stop work");
  assert.equal(decision.wouldDeny, true, "...but must say what enforcement would have stopped");
  assert.equal(decision.reason, "no-grant");
});

test("the founder is never locked out by the committed registry", () => {
  const decision = authorize({
    registry: registry(),
    actorType: "human",
    actorId: "founder",
    capability: "task.initialize",
    scope: { type: "task", id: "task-probe" },
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, "founder-authority");
});

test("every agent in factory.config.json can be attributed by the registry", () => {
  // Not a grant-for-grant check — scopes and capabilities differ by role. This
  // only holds that no configured agent is entirely absent from the table, so
  // report mode is not silently measuring a roster that no longer exists.
  const config = JSON.parse(readFileSync(join(HQ_ROOT, "factory", "factory.config.json"), "utf8"));
  // `_doc` and friends are prose, not routes.
  const configured = new Set(
    Object.entries(config.openclawIntegration?.agentIds || {})
      .filter(([key]) => !key.startsWith("_"))
      .map(([, agentId]) => agentId),
  );
  const granted = new Set(registry().grants.map((grant) => grant.actorId));
  const missing = [...configured].filter((agent) => !granted.has(agent));
  assert.deepEqual(missing, [], `agents in factory.config.json with no grant at all: ${missing.join(", ")}`);
});

test("every actor the factory sends is granted what it asks for, so report mode measures policy", () => {
  // On 2026-09-14 the table granted stage names (reviewer, backend-builder)
  // while the factory sent agent ids (claude, codex) — 604 of 658 audited
  // checks read "would deny", which measured the naming mismatch, not policy.
  // Derive the actors from the code that picks them, so the next change to
  // defaultAssignments fails here instead of in the audit log.
  const probe = (actorId, capability) => authorize({
    registry: registry(),
    actorType: "agent",
    actorId,
    capability,
    scope: { type: "task", id: "task-probe", projectId: "lifemaxing" },
  });
  const dispatchers = new Set(["recovery"]);
  const releasers = new Set();
  for (const preferredBuilder of ["auto", "codex", "claude", "frontend"]) {
    for (const workType of ["ui", "backend"]) {
      const assignments = defaultAssignments({ preferredBuilder, workType });
      for (const actor of Object.values(assignments)) dispatchers.add(actor);
      releasers.add(assignments.release);
    }
  }
  const ungranted = [
    ...[...dispatchers].filter((actor) => probe(actor, "task.dispatch").wouldDeny).map((actor) => `${actor}:task.dispatch`),
    ...[...releasers].filter((actor) => probe(actor, "github.open-pr").wouldDeny).map((actor) => `${actor}:github.open-pr`),
    ...["objective.run", "objective.recover"].filter((cap) => probe("openclaw-factory", cap).wouldDeny).map((cap) => `openclaw-factory:${cap}`),
  ];
  assert.deepEqual(ungranted, []);
});
