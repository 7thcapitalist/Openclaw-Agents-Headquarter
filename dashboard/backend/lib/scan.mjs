import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import { join } from "path";
import { configPath } from "./paths.mjs";

/**
 * @param {string} root
 * @returns {Array<{ project: string, id: string, path: string, config: object }>}
 */
export function scanAgents(root) {
  const agentsRoot = join(root, "agents");
  if (!existsSync(agentsRoot)) return [];

  const out = [];
  for (const project of readdirSync(agentsRoot, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    if (project.name.startsWith("_") || project.name.startsWith(".")) continue;
    const projPath = join(agentsRoot, project.name);
    for (const ent of readdirSync(projPath, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      if (ent.name.startsWith(".")) continue;
      const id = ent.name;
      const cfgFile = configPath(root, project.name, id);
      if (!existsSync(cfgFile)) continue;
      try {
        const raw = readFileSync(cfgFile, "utf8");
        const config = JSON.parse(raw);
        out.push({
          project: project.name,
          id,
          path: join(projPath, id),
          config,
        });
      } catch {
        // skip invalid JSON
      }
    }
  }
  return out.sort((a, b) =>
    a.project === b.project ? a.id.localeCompare(b.id) : a.project.localeCompare(b.project)
  );
}

/**
 * @param {string} dir
 */
export function latestOutputFile(dir) {
  const outDir = join(dir, "outputs");
  if (!existsSync(outDir)) return null;
  const files = readdirSync(outDir)
    .filter((f) => !f.startsWith(".") && f !== ".gitkeep")
    .map((f) => {
      const p = join(outDir, f);
      try {
        const st = statSync(p);
        return st.isFile() ? { path: p, name: f, mtime: st.mtimeMs } : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (!files.length) return null;
  files.sort((a, b) => b.mtime - a.mtime);
  return files[0];
}

/**
 * Prefer outputs/latest.md when present; otherwise newest *.md by mtime.
 * @param {string} dir agent root directory
 * @returns {{ path: string, name: string, mtime: number } | null}
 */
export function preferredMarkdownOutput(dir) {
  const outDir = join(dir, "outputs");
  if (!existsSync(outDir)) return null;
  const preferred = join(outDir, "latest.md");
  if (existsSync(preferred)) {
    try {
      const st = statSync(preferred);
      if (st.isFile()) return { path: preferred, name: "latest.md", mtime: st.mtimeMs };
    } catch {
      /* fall through */
    }
  }
  const mdFiles = readdirSync(outDir)
    .filter((f) => f.endsWith(".md") && !f.startsWith("."))
    .map((f) => {
      const p = join(outDir, f);
      try {
        const st = statSync(p);
        return st.isFile() ? { path: p, name: f, mtime: st.mtimeMs } : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (!mdFiles.length) return null;
  mdFiles.sort((a, b) => b.mtime - a.mtime);
  return mdFiles[0];
}

/**
 * @param {string} dir
 * @param {number} lines
 */
export function tailLog(dir, lines = 30) {
  const logFile = join(dir, "logs", "latest.log");
  if (!existsSync(logFile)) return "";
  const text = readFileSync(logFile, "utf8");
  const all = text.split("\n");
  return all.slice(Math.max(0, all.length - lines)).join("\n");
}
