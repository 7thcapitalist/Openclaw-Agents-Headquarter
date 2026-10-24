// Pre-review PR checklist: secrets, scope and tests, decided from a diff alone.
// Pure functions; the CLI in scripts/pr-checklist.mjs feeds them from git.

const SECRET_FILE_PATTERNS = [
  /(^|\/)\.env(\.|$)/,
  /(^|\/)auth\.json$/,
  /(^|\/)credentials(\.json)?$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa)$/,
  /\.(pem|key|p12|pfx)$/i,
];
const ENV_EXAMPLE = /(^|\/)\.env\.(example|sample|template)$/;

const SECRET_CONTENT_PATTERNS = [
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["openai-key", /\bsk-[A-Za-z0-9]{32,}\b/],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["bearer-token", /\bBearer\s+[A-Za-z0-9._-]{30,}/],
];

const CODE_FILE = /\.(mjs|cjs|js|ts|tsx|jsx)$/;
const TEST_FILE = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[a-z]+$/;

const globToRegExp = (glob) => {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") { out += ".*"; i++; if (glob[i + 1] === "/") i++; }
    else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
};

const norm = (p) => p.replaceAll("\\", "/").replace(/^\.\//, "");

export function runChecklist({ files, addedLines = {}, scope = [], requireTests = true }) {
  const paths = files.map(norm);
  const checks = [];

  const secretFiles = paths.filter((p) => !ENV_EXAMPLE.test(p) && SECRET_FILE_PATTERNS.some((r) => r.test(p)));
  const secretHits = [];
  for (const [file, lines] of Object.entries(addedLines)) {
    for (const line of lines) {
      for (const [kind, re] of SECRET_CONTENT_PATTERNS) if (re.test(line)) secretHits.push(`${norm(file)}: ${kind}`);
    }
  }
  checks.push({
    name: "secrets",
    ok: !secretFiles.length && !secretHits.length,
    details: [...secretFiles.map((f) => `credential file: ${f}`), ...secretHits],
  });

  if (scope.length) {
    const res = scope.map((g) => globToRegExp(norm(g)));
    const outside = paths.filter((p) => !res.some((r) => r.test(p)));
    checks.push({ name: "scope", ok: !outside.length, details: outside.map((f) => `outside scope: ${f}`) });
  } else {
    checks.push({ name: "scope", ok: true, skipped: true, details: ["no --scope given"] });
  }

  const code = paths.filter((p) => CODE_FILE.test(p) && !TEST_FILE.test(p));
  const tests = paths.filter((p) => TEST_FILE.test(p));
  const needTests = requireTests && code.length > 0 && tests.length === 0;
  checks.push({
    name: "tests",
    ok: !needTests,
    details: needTests ? [`code changed without any test file: ${code.join(", ")}`] : [`${tests.length} test file(s) in diff`],
  });

  return { ok: checks.every((c) => c.ok), checks };
}

export function parseAddedLines(diff) {
  const added = {};
  let file = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) { file = line.slice(4).replace(/^b\//, "").trim(); if (file === "/dev/null") file = null; continue; }
    if (file && line.startsWith("+")) (added[file] ||= []).push(line.slice(1));
  }
  return added;
}
