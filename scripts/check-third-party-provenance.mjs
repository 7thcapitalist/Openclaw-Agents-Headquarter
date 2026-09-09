#!/usr/bin/env node
import { resolve } from "path";
import { readProvenance } from "../factory/lib/third-party/provenance.mjs";

try {
  const manifest = readProvenance(resolve(process.cwd()));
  process.stdout.write(`third-party provenance valid: ${manifest.sources.length} source(s), ${manifest.artifacts.length} artifact(s)\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
