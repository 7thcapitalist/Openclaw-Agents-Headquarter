import { resolve, sep } from "path";

// Filenames that must never be read into a context pack, a question body, or a
// digest, regardless of where they sit.
export const SECRET_FILENAME_PATTERNS = [
  /^\.env(\.|$)/i,
  /\.pem$/i,
  /\.key$/i,
  /^id_rsa/i,
  /(^|[._-])credentials?([._-]|$)/i,
  /(^|[._-])secrets?([._-]|$)/i,
];

// Value patterns scrubbed from every fragment before it is emitted. Conservative
// on purpose: a few false positives are acceptable, a leaked key is not.
export const SECRET_VALUE_PATTERNS = [
  { name: "aws-akia", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "openai-sk", re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: "gh-token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "bearer", re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g },
  { name: "pem-block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: "db-url", re: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?):\/\/[^\s/@]+:[^\s/@]+@/g },
];

export function isSecretFilename(name) {
  const base = String(name || "").split("/").pop();
  return SECRET_FILENAME_PATTERNS.some((re) => re.test(base));
}

// Replace every secret-looking value with "[redacted: <name>]".
// Returns the scrubbed text plus a per-pattern hit count.
export function scrubText(text) {
  let out = String(text ?? "");
  const hits = [];
  for (const { name, re } of SECRET_VALUE_PATTERNS) {
    let count = 0;
    out = out.replace(new RegExp(re.source, re.flags), () => {
      count += 1;
      return `[redacted: ${name}]`;
    });
    if (count > 0) hits.push({ name, count });
  }
  return { text: out, hits };
}

// Resolve `candidate` and assert it is inside `baseDir`. Defends against
// "../.." traversal and absolute-path escapes. Returns the resolved path.
export function assertInsideDir(baseDir, candidate) {
  const base = resolve(baseDir);
  const target = resolve(base, candidate);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`path escapes context dir: ${candidate}`);
  }
  return target;
}
