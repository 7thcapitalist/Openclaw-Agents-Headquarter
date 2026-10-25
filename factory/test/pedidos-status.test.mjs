// SOF-221: tempo decorrido e % de quota por pedido, a partir do ledger.
import test from "node:test";
import assert from "node:assert/strict";
import { summarizePedidos, renderPedidos, formatElapsed } from "../../scripts/pedidos-status.mjs";

const usage = (eventId, taskId, inputTokens, extra = {}) => ({ eventId, taskId, eventType: "usage", inputTokens, cachedInputTokens: 0, outputTokens: 0, ...extra });

test("pedido concluído: tempo primeira->última linha e % da quota", () => {
  const ledger = [
    { at: "2026-10-25T10:00:00Z", key: "a", file: "a.md", task: "t1", pr: null },
    { at: "2026-10-25T10:12:30Z", key: "a", file: "a.md", pr: 5, first_pr_tests_passed: true },
  ];
  const [r] = summarizePedidos({ ledger, costEvents: [usage("1", "a", 100000), usage("2", "b", 999)], quotaTokens: 1000000, now: Date.parse("2026-10-26T00:00:00Z") });
  assert.equal(r.status, "concluído");
  assert.equal(r.elapsedMs, 750000);
  assert.equal(r.quotaPct, 10);
  assert.match(renderPedidos([r]), /a {2}concluído {2}tempo 12m30s {2}quota 10\.0%/);
});

test("pedido em andamento conta até agora; falho é marcado; evento substituído é ignorado", () => {
  const ledger = [
    { at: "2026-10-25T10:00:00Z", key: "x", task: "t1" },
    { at: "2026-10-25T10:00:00Z", key: "y", status: "failed" },
  ];
  const rows = summarizePedidos({ ledger, costEvents: [usage("1", "x", 500), usage("2", "x", 700, { replacesEventId: "1" })], quotaTokens: 1000, now: Date.parse("2026-10-25T11:00:00Z") });
  const x = rows.find((r) => r.key === "x"), y = rows.find((r) => r.key === "y");
  assert.equal(x.status, "em andamento");
  assert.equal(x.elapsedMs, 3600000);
  assert.equal(x.tokens, 700);
  assert.equal(y.status, "falhou");
});

test("ledger vazio e formatElapsed", () => {
  assert.equal(renderPedidos(summarizePedidos({ ledger: [], costEvents: [] })), "Nenhum pedido no ledger.");
  assert.equal(formatElapsed(3720000), "1h02m");
});
