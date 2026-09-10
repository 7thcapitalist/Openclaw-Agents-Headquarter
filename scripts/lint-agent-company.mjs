#!/usr/bin/env node
import { resolve } from "path";
import { lintAgentCompanyPackage } from "../factory/lib/packages/agent-company-linter.mjs";
const result = lintAgentCompanyPackage(resolve(process.argv[2] || "."));
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); if (!result.valid) process.exitCode = 1;
