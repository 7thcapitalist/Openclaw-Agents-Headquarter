import test from "node:test"; import assert from "node:assert/strict"; import { mkdtempSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { runPreflight } from "../../scripts/preflight.mjs";
const okRun = (_cwd, args) => (args[0] === "status" ? "" : "abc\tHEAD\n");
test("tudo ok passa", () => { const r = runPreflight({ run: okRun, nodeVersion: "22.1.0", worktree: join(tmpdir(), "nao-existe-preflight") }); assert.equal(r.ok, true); });
test("falha simulada: repo sujo + node antigo", () => {
  const r = runPreflight({ run: (c, a) => (a[0] === "status" ? " M a.js\n" : "x"), nodeVersion: "18.0.0" });
  assert.equal(r.ok, false); assert.deepEqual(r.checks.filter((c) => !c.ok).map((c) => c.name), ["node>=20", "git limpo"]);
});
test("falha simulada: remoto inacessível + worktree ocupada", () => {
  const dir = mkdtempSync(join(tmpdir(), "pf-")); writeFileSync(join(dir, "f"), "1");
  const r = runPreflight({ run: (c, a) => { if (a[0] === "ls-remote") throw new Error("could not read from remote"); return ""; }, nodeVersion: "20.0.0", worktree: dir });
  assert.deepEqual(r.checks.filter((c) => !c.ok).map((c) => c.name), ["remoto origin", "worktree livre"]);
});
