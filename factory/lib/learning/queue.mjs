// Findings queue for the Company Learning System.
//
// A durable, fingerprint-deduplicated list of what the analysis layer has
// observed. Lives in HQ runtime state (gitignored):
//   dashboard/backend/data/factory/_learning/findings.json
//
// The queue never auto-resolves a finding — historical task evidence does not
// disappear. Only the founder changes a finding's status (promote / dismiss),
// and a recurrence after either is surfaced loudly rather than silently merged.
//
// Pure over its store object; fs only in read/write helpers. Node builtins only.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";

const STORE_FILE = "findings.json";
export const STATUSES = new Set(["open", "promoted", "dismissed", "resolved"]);

export function learningRootFor(factoryStateRoot) {
  return join(resolve(factoryStateRoot), "_learning");
}

export function emptyStore() {
  return { version: 1, updatedAt: null, nextId: 1, findings: [] };
}

export function readQueue(learningRoot) {
  const path = join(resolve(learningRoot), STORE_FILE);
  if (!existsSync(path)) return emptyStore();
  const value = JSON.parse(readFileSync(path, "utf8"));
  return { ...emptyStore(), ...value };
}

export function writeQueue(learningRoot, store) {
  const path = join(resolve(learningRoot), STORE_FILE);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  renameSync(temp, path);
}

function formatId(n) {
  return `L-${String(n).padStart(4, "0")}`;
}

function unionTaskIds(a, b) {
  return [...new Set([...(a || []), ...(b || [])])].sort();
}

// Merge a fresh analysis result into the store. `incoming` is the flat list of
// findings/patterns/agentImprovements from analyzeTasks(). Returns the mutated
// store plus a change report.
export function reconcile(store, incoming, { now = new Date().toISOString() } = {}) {
  const next = structuredClone(store);
  const byKey = new Map(next.findings.map((f) => [`${f.kind}::${f.fingerprint}`, f]));
  const added = [];
  const updated = [];
  const recurred = [];

  for (const item of incoming || []) {
    const key = `${item.kind}::${item.fingerprint}`;
    const existing = byKey.get(key);
    if (!existing) {
      const created = {
        id: formatId(next.nextId),
        status: "open",
        kind: item.kind,
        scope: item.scope || "global",
        project: item.project ?? null,
        targetRole: item.targetRole ?? null,
        fingerprint: item.fingerprint,
        title: item.title,
        observation: item.observation,
        recommendation: item.recommendation || "",
        confidence: item.confidence || "medium",
        occurrences: item.occurrences || item.taskIds?.length || 1,
        taskIds: [...(item.taskIds || [])].sort(),
        evidence: (item.evidence || []).slice(0, 6),
        firstSeenAt: now,
        lastSeenAt: now,
        history: [{ at: now, event: "opened" }],
      };
      next.nextId += 1;
      next.findings.push(created);
      byKey.set(key, created);
      added.push(created.id);
      continue;
    }

    const mergedTaskIds = unionTaskIds(existing.taskIds, item.taskIds);
    const grew = mergedTaskIds.length > existing.taskIds.length;
    existing.taskIds = mergedTaskIds;
    existing.occurrences = Math.max(existing.occurrences || 0, item.occurrences || 0, mergedTaskIds.length);
    existing.observation = item.observation;
    existing.recommendation = item.recommendation || existing.recommendation;
    existing.confidence = item.confidence || existing.confidence;
    existing.evidence = (item.evidence || existing.evidence || []).slice(0, 6);
    existing.lastSeenAt = now;

    if (existing.status === "open") {
      if (grew) {
        existing.history.push({ at: now, event: "reinforced", taskIds: item.taskIds || [] });
        updated.push(existing.id);
      }
    } else if (grew) {
      // Recurred after the founder already acted on it. Do not silently reopen;
      // flag it so the digest can call it out.
      existing.recurredAfter = existing.status;
      existing.recurredAt = now;
      existing.history.push({ at: now, event: `recurred-after-${existing.status}`, taskIds: item.taskIds || [] });
      recurred.push(existing.id);
    }
  }

  next.updatedAt = now;
  return { store: next, added, updated, recurred };
}

export function findById(store, id) {
  return store.findings.find((f) => f.id === id) || null;
}

export function setStatus(store, id, status, { reason = null, actor = "founder", now = new Date().toISOString() } = {}) {
  if (!STATUSES.has(status)) throw new Error(`Unknown finding status: ${status}`);
  const next = structuredClone(store);
  const finding = next.findings.find((f) => f.id === id);
  if (!finding) throw new Error(`No such finding: ${id}`);
  const from = finding.status;
  finding.status = status;
  finding.history.push({ at: now, event: `status:${from}->${status}`, actor, reason: reason || undefined });
  if (status === "promoted") finding.promotedAt = now;
  if (status === "dismissed") {
    finding.dismissedAt = now;
    finding.dismissReason = reason || undefined;
    // Raw excerpts are dropped on dismiss; the fingerprint + title stay as an index.
    finding.evidence = [];
  }
  delete finding.recurredAfter;
  delete finding.recurredAt;
  next.updatedAt = now;
  return { store: next, finding };
}

export function selectFindings(store, { kind = null, scope = null, status = "open", project = null } = {}) {
  return store.findings.filter((f) =>
    (status == null || f.status === status) &&
    (kind == null || f.kind === kind) &&
    (scope == null || f.scope === scope) &&
    (project == null || f.project === project));
}

// Retention: drop raw evidence excerpts from findings older than `days` that are
// still open, keeping the title/fingerprint/observation index. Dismissed
// findings already have no excerpts. Promoted findings keep a trimmed pointer.
export function pruneEvidence(store, { days = 90, now = new Date().toISOString() } = {}) {
  const cutoff = Date.parse(now) - days * 864e5;
  const next = structuredClone(store);
  let pruned = 0;
  for (const f of next.findings) {
    if (!f.evidence?.length) continue;
    const seen = Date.parse(f.lastSeenAt || f.firstSeenAt || now);
    if (!Number.isNaN(seen) && seen < cutoff) {
      f.evidence = [];
      f.history.push({ at: now, event: "evidence-pruned" });
      pruned += 1;
    }
  }
  next.updatedAt = now;
  return { store: next, pruned };
}
