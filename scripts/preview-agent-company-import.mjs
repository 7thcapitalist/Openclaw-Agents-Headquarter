#!/usr/bin/env node
// Preview what an Agent Companies package would propose. Read-only: this prints
// a diff and changes nothing, here or in the package.
//
//   node scripts/preview-agent-company-import.mjs <package-dir>
//
// Applying a proposal is an ordinary pull request against factory/agents.json
// and factory/projects.json, reviewed and merged by a human. There is
// deliberately no --apply.

import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { previewAgentCompanyImport } from "../factory/lib/packages/agent-company-import.mjs";

const hqRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [packageDir] = process.argv.slice(2);

if (!packageDir) {
  process.stderr.write("usage: preview-agent-company-import.mjs <package-dir>\n");
  process.exit(2);
}

try {
  const preview = previewAgentCompanyImport({ packageDir: resolve(packageDir), hqRoot });
  process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
  // A rejected package is a non-zero exit so a caller can gate on it, but it is
  // still printed in full: the findings are the useful part.
  process.exitCode = preview.status === "rejected" ? 1 : 0;
} catch (error) {
  process.stderr.write(`${error?.message || error}\n`);
  process.exitCode = 2;
}
