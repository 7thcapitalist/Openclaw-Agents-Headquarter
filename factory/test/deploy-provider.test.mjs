import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { createVercelAdapter, MissingCredentialError } from "../lib/deploy/adapters/vercel.mjs";
import { defaultAdapters, selectProvider } from "../lib/deploy/provider.mjs";

test("provider selection follows manifest and global configuration", () => {
  assert.equal(selectProvider({ provider: "vercel" }).id, "vercel");
  assert.equal(selectProvider({ provider: "none" }).id, "none");
  assert.equal(selectProvider({}, { config: { deploy: { defaultProvider: "none" } } }).id, "none");
  const custom = { id: "custom", async deploy() {} };
  assert.equal(selectProvider({ provider: "custom" }, { adapters: { custom } }), custom);
  assert.throws(() => selectProvider({ provider: "missing" }, { adapters: defaultAdapters }), /Unknown deployment provider/);
});

test("orchestrator contains no provider-specific branch", () => {
  const source = readFileSync(new URL("../lib/deploy/orchestrator.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /["']vercel["']/i);
  assert.doesNotMatch(source, /switch\s*\([^)]*provider/i);
});

test("Vercel adapter requires env credentials and never passes the token in arguments or logs", async () => {
  const calls = [];
  const logs = [];
  const adapter = createVercelAdapter({
    exec: async (file, args, options) => {
      calls.push({ file, args, env: options.env });
      return { code: 0, stdout: args.includes("deploy") ? "https://example.vercel.app\nfake-token" : "fake-token", stderr: "" };
    },
  });
  await assert.rejects(() => adapter.deploy({ repoPath: "/tmp", env: {} }), MissingCredentialError);
  const result = await adapter.deploy({ repoPath: "/tmp", env: { VERCEL_TOKEN: "fake-token" }, logger: (line) => logs.push(line) });
  assert.equal(result.url, "https://example.vercel.app");
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => !call.args.includes("fake-token")));
  assert.doesNotMatch(logs.join("\n"), /fake-token/);
});
