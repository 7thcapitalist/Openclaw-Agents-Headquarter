#!/usr/bin/env node
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { openDb } from "./db.mjs";
import { labRoot, assertSafeSlug } from "./paths.mjs";
import { registerAgent } from "./register-agent.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = labRoot(process.argv[2]);
const project = process.argv[3];
const id = process.argv[4];

if (!project || !id) {
  console.error("Usage: register-agent-cli.mjs <root> <project> <id>");
  process.exit(1);
}

assertSafeSlug(project, id);

const dataDir = join(__dirname, "..", "data");
const db = openDb(dataDir);
registerAgent(root, project, id, db);
db.close();
