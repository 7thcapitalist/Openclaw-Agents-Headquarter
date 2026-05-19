import { homedir } from "os";
import { join, resolve, normalize } from "path";

/**
 * @param {string} root
 */
export function labRoot(root) {
  return resolve(root || join(homedir(), "agent-lab"));
}

/**
 * @param {string} p
 */
export function expandHome(p) {
  if (!p || typeof p !== "string") return p;
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return p;
}

/**
 * @param {string} root
 * @param {string} project
 * @param {string} id
 */
export function agentKey(project, id) {
  return `${project}/${id}`;
}

/**
 * @param {string} project
 * @param {string} id
 */
export function pm2Name(project, id) {
  return `${project}-${id}`;
}

/**
 * @param {string} root
 * @param {string} project
 * @param {string} id
 */
export function agentDir(root, project, id) {
  const base = resolve(join(root, "agents"));
  const dir = resolve(join(base, project, id));
  if (!dir.startsWith(base + "/") && dir !== base) {
    throw new Error("Invalid agent path");
  }
  return dir;
}

/**
 * @param {string} root
 * @param {string} project
 * @param {string} id
 */
export function assertSafeSlug(project, id) {
  const re = /^[a-z0-9][a-z0-9-]*$/;
  if (!re.test(project) || !re.test(id)) {
    throw new Error("Invalid project or agent id");
  }
}

/**
 * @param {string} root
 * @param {string} project
 * @param {string} id
 */
export function configPath(root, project, id) {
  return join(agentDir(root, project, id), "agent.config.json");
}
