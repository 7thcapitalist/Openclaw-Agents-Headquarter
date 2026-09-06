#!/usr/bin/env node
// Undo scripts/apply-review-model-routing.mjs by restoring the backup it made.
//
//   node scripts/revert-review-model-routing.mjs
//   openclaw daemon restart

import { existsSync, copyFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CONFIG = process.env.OPENCLAW_CONFIG || join(homedir(), ".openclaw", "openclaw.json");
const BACKUP = `${CONFIG}.before-review-routing`;

if (!existsSync(BACKUP)) {
  console.error(`No backup at ${BACKUP}; nothing to revert.`);
  process.exit(1);
}
copyFileSync(BACKUP, CONFIG);
console.log(`Restored ${CONFIG} from ${BACKUP}. Run: openclaw daemon restart`);
