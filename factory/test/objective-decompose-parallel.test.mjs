import test from "node:test";
import assert from "node:assert/strict";
import { decomposeObjective } from "../lib/objective/decompose.mjs";

const REPO = process.cwd();
const node = (id, role, workType, extra = {}) => ({
  id, role, objective: `Do ${id}`, acceptanceCriteria: [`${id} done when its check passes`, "tests pass"],
  workType, risk: "low", dependsOn: [], ...extra,
});
const run = (objective, nodes) => decomposeObjective({
  hqRoot: REPO, objective, project: "demo", repo: REPO, execute: async () => JSON.stringify({ nodes }),
});

test("pedido 1: 4 micro-tarefas independentes, cada uma com 'pronto quando'", async () => {
  const g = await run("Preparar beta do app: login, perfil, ajustes e logs", [
    node("login-api", "backend-builder", "backend"),
    node("profile-ui", "frontend-builder", "ui"),
    node("settings-ui", "frontend-builder", "ui"),
    node("audit-log", "backend-builder", "ops"),
  ]);
  const nodes = Object.values(g.nodes);
  assert.equal(nodes.length, 4);
  assert.ok(nodes.every((n) => n.dependsOn.length === 0), "all four can start in parallel");
  assert.ok(nodes.every((n) => n.contract.acceptanceCriteria.length > 0), "each has a done-when");
  assert.equal(g.integration.dependsOn.length, 4);
});

test("pedido 2: 2 tarefas, a segunda espera a primeira; 5 tarefas é recusado", async () => {
  const g = await run("Nova API de pedidos e tela que a consome", [
    node("orders-api", "backend-builder", "backend"),
    node("orders-ui", "frontend-builder", "ui", { dependsOn: ["orders-api"] }),
  ]);
  const [api, ui] = Object.values(g.nodes);
  assert.deepEqual(api.dependsOn, []);
  assert.deepEqual(ui.dependsOn, [api.id]);

  await assert.rejects(run("grande demais", ["a", "b", "c", "d", "e"].map((i) => node(i, "backend-builder", "backend"))), /cap is 4/);
});

test("micro-tarefa sem 'pronto quando' é recusada", async () => {
  await assert.rejects(run("x", [node("a", "backend-builder", "backend", { acceptanceCriteria: [] })]), /acceptance/i);
});
