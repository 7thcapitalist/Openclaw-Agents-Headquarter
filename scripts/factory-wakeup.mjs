#!/usr/bin/env node
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { defaultWakeupPaths, processNextWakeup } from "../factory/lib/wakeups/worker.mjs";

const hqRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaults = defaultWakeupPaths(hqRoot);
const stateRoot = resolve(process.env.FACTORY_STATE_ROOT || defaults.stateRoot);
const queuePath = resolve(process.env.FACTORY_WAKEUP_QUEUE || defaults.queuePath);

try {
  const result = await processNextWakeup({ hqRoot, stateRoot, queuePath });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status === "dead-letter") process.exitCode = 2;
} catch (error) {
  process.stderr.write(`${error?.message || error}\n`);
  process.exitCode = 1;
}
