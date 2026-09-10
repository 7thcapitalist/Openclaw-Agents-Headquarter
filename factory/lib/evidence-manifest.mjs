// Versioned, commit-bound evidence manifests (FCT-P0-05).
//
// The problem this replaces: the deterministic gate checked that each stage
// named at least one non-empty file inside the worktree. A stage could write
// "all tests passed" into a text file and clear the gate. Nothing tied evidence
// to the dispatch that produced it, to the commit under review, or to the
// acceptance criteria it was supposed to prove.
//
// A manifest binds evidence to a specific execution and a specific tree, and
// records HOW each claim was established. The load-bearing distinction:
//
//   observed      — the factory ran the command itself and recorded the real
//                   subprocess exit status. Trustworthy.
//   asserted      — an agent says it ran something. Its own report about its own
//                   work; recorded, never trusted as proof.
//   independently-verified
//                 — observed, and produced by a stage that is independent of the
//                   builder.
//
// Everything an agent supplies is untrusted input. Manifests are DATA: no
// command inside one is ever executed by the factory.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { criteriaForState } from "./evidence-criteria.mjs";

export const EVIDENCE_MANIFEST_VERSION = 1;

export const PROOF_KINDS = new Set(["observed", "asserted", "independently-verified"]);

// Artifact classes. `command-output` is the only one that can carry an exit
// status; the others describe human or file evidence.
export const ARTIFACT_TYPES = new Set([
  "command-output",
  "manual-scenario",
  "screenshot",
  "diff",
  "report",
  "file",
]);

const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// Worktree containment. Evidence must live inside the task's own worktree —
// never a symlink out of it, never an absolute path elsewhere.
export function resolveContainedPath(worktree, relPath) {
  const root = resolve(worktree);
  const abs = resolve(root, String(relPath ?? ""));
  if (abs !== root && !abs.startsWith(`${root}/`)) {
    throw new Error(`Evidence escapes worktree: ${relPath}`);
  }
  return abs;
}

// ── building ─────────────────────────────────────────────────────────────────

// Describe one artifact on disk. Digest, size and type are recorded here, by us,
// from the real file — not taken from whatever the agent claimed.
export function describeArtifact(worktree, input) {
  const relPath = typeof input === "string" ? input : input?.path;
  if (!relPath || !String(relPath).trim()) throw new Error("An evidence artifact needs a path.");

  const abs = resolveContainedPath(worktree, relPath);
  if (!existsSync(abs)) throw new Error(`Evidence does not exist: ${relPath}`);
  const stat = statSync(abs);
  if (!stat.isFile()) throw new Error(`Evidence must be a file: ${relPath}`);
  if (stat.size === 0) throw new Error(`Evidence must be a non-empty file: ${relPath}`);
  if (stat.size > MAX_ARTIFACT_BYTES) {
    throw new Error(`Evidence artifact is too large to hash (${stat.size} bytes): ${relPath}`);
  }

  const declared = typeof input === "object" && input ? input : {};
  const type = ARTIFACT_TYPES.has(declared.type) ? declared.type : "file";

  const artifact = {
    id: String(declared.id || relPath),
    path: String(relPath),
    type,
    bytes: stat.size,
    sha256: sha256File(abs),
  };

  // A command string is recorded for the founder to read. It is never executed.
  if (declared.command) artifact.command = String(declared.command).slice(0, 2000);
  if (declared.scenario) artifact.scenario = String(declared.scenario).slice(0, 2000);
  if (declared.startedAt) artifact.startedAt = String(declared.startedAt);
  if (declared.endedAt) artifact.endedAt = String(declared.endedAt);

  // An exit status is only meaningful when someone actually ran something. The
  // caller decides whether it was observed; an agent cannot self-certify.
  if (declared.exitStatus !== undefined && declared.exitStatus !== null) {
    const code = Number(declared.exitStatus);
    if (!Number.isInteger(code)) throw new Error(`Evidence exit status must be an integer: ${relPath}`);
    artifact.exitStatus = code;
  }
  artifact.observed = declared.observed === true;

  return artifact;
}

/**
 * Build a manifest for one stage result.
 *
 * Every binding field comes from the factory's own state, never from the agent:
 * an agent cannot claim its evidence belongs to a different dispatch or commit.
 */
export function buildManifest(state, {
  stage,
  actor,
  dispatchId,
  attempt = 1,
  commitSha = null,
  artifacts = [],
  criteriaProofs = [],
  verdict = "pass",
  limitations = null,
  runtime = null,
  strict = true,
  now = new Date().toISOString(),
}) {
  if (!stage) throw new Error("An evidence manifest needs a stage.");
  if (!dispatchId) throw new Error("An evidence manifest needs a dispatch id.");

  // `strict` (the default) is for evidence a stage is actually asserting: a
  // path that does not resolve is an error the stage must see.
  //
  // The workflow's automatic binding pass uses strict:false instead. Its job is
  // to record digests for whatever IS on disk, and `completeStage` has never
  // required evidence files to exist — the protocol layer checks that
  // separately via verifyEvidence(). Hard-failing here would change a contract
  // many callers rely on. An artifact that cannot be described is dropped and
  // noted, never silently treated as present.
  const described = [];
  const unresolved = [];
  for (const artifact of artifacts) {
    try {
      described.push(describeArtifact(state.worktree, artifact));
    } catch (error) {
      if (strict) throw error;
      unresolved.push({
        path: String(typeof artifact === "string" ? artifact : artifact?.path || "(unnamed)"),
        reason: String(error.message || error),
      });
    }
  }
  const byId = new Set(described.map((a) => a.id));

  const proofs = normalizeCriteriaProofs(state, stage, criteriaProofs, byId);

  return {
    version: EVIDENCE_MANIFEST_VERSION,
    objectiveId: objectiveIdFor(state),
    taskId: state.task.id,
    dispatchId: String(dispatchId),
    attempt: Number(attempt) || 1,
    stage: String(stage),
    actor: String(actor || ""),
    runtime: runtime ? sanitizeRuntime(runtime) : null,
    repo: state.repo || null,
    branch: state.branch || null,
    commitSha: commitSha ? String(commitSha) : null,
    createdAt: now,
    verdict: String(verdict),
    limitations: limitations ? String(limitations).slice(0, 2000) : null,
    criteria: proofs,
    artifacts: described,
    // Recorded so the release gate and the founder can see that a named
    // artifact could not be bound, rather than it vanishing from the account.
    ...(unresolved.length ? { unresolvedArtifacts: unresolved } : {}),
  };
}

function sanitizeRuntime(runtime) {
  return {
    harness: runtime.harness ? String(runtime.harness) : null,
    agentId: runtime.agentId ? String(runtime.agentId) : null,
    runId: runtime.runId ? String(runtime.runId) : null,
    model: runtime.model ? String(runtime.model) : null,
  };
}

// An objective-node task id looks like obj-<8 hex>-<slug>.
export function objectiveIdFor(state) {
  return String(state?.task?.id || "").match(/^(obj-[0-9a-f]{8})-/)?.[1] || null;
}

function normalizeCriteriaProofs(state, stage, criteriaProofs, artifactIds) {
  const known = new Map(criteriaForState(state).map((c) => [c.id, c]));
  const out = [];
  const seen = new Set();

  for (const raw of Array.isArray(criteriaProofs) ? criteriaProofs : []) {
    const id = String(raw?.id || "").trim();
    if (!id) continue;
    if (!known.has(id)) {
      // A proof for a criterion this task does not have is a binding error, not
      // something to quietly accept.
      throw new Error(`Evidence references unknown acceptance criterion: ${id}`);
    }
    if (seen.has(id)) throw new Error(`Duplicate proof for acceptance criterion: ${id}`);
    seen.add(id);

    const status = ["proven", "blocked", "not-applicable"].includes(raw.status) ? raw.status : "blocked";
    const proofArtifacts = (Array.isArray(raw.artifacts) ? raw.artifacts : []).map((x) => String(x));
    for (const ref of proofArtifacts) {
      if (!artifactIds.has(ref)) throw new Error(`Criterion ${id} cites unknown artifact: ${ref}`);
    }
    const kind = PROOF_KINDS.has(raw.kind) ? raw.kind : "asserted";

    if (status === "proven" && proofArtifacts.length === 0) {
      throw new Error(`Criterion ${id} is marked proven but cites no artifact.`);
    }
    if ((status === "blocked" || status === "not-applicable") && !String(raw.note || "").trim()) {
      throw new Error(`Criterion ${id} is ${status} and must say why.`);
    }

    out.push({
      id,
      text: known.get(id).text,
      status,
      kind,
      artifacts: proofArtifacts,
      note: raw.note ? String(raw.note).slice(0, 1000) : null,
    });
  }

  // Completeness is deliberately NOT enforced here. One stage may prove a
  // subset — QA proves behaviour, security proves its own criteria — so
  // "is every criterion accounted for?" is a question about the whole task and
  // is answered by the release gate (assertReleaseReady/unprovenCriteria).
  return out;
}

// ── verification ─────────────────────────────────────────────────────────────

/**
 * Re-check a manifest against reality at the moment it is used.
 *
 * Returns { ok, errors[] } rather than throwing, so callers can surface every
 * problem at once instead of only the first.
 */
export function verifyManifest(state, manifest, {
  stage = null,
  dispatchId = null,
  attempt = null,
  commitSha = null,
  now = new Date().toISOString(),
} = {}) {
  const errors = [];
  const fail = (message) => errors.push(message);

  if (!manifest || typeof manifest !== "object") {
    return { ok: false, errors: ["Evidence manifest is missing or not an object."] };
  }
  if (Number(manifest.version) !== EVIDENCE_MANIFEST_VERSION) {
    return { ok: false, errors: [`Unsupported evidence manifest version: ${manifest.version}`] };
  }

  // Binding: this manifest must describe THIS execution.
  if (manifest.taskId !== state.task.id) {
    fail(`Evidence was created for task ${manifest.taskId}, not ${state.task.id}.`);
  }
  if (stage && manifest.stage !== stage) {
    fail(`Evidence was created for stage ${manifest.stage}, not ${stage}.`);
  }
  if (dispatchId && manifest.dispatchId !== dispatchId) {
    fail(`Evidence belongs to dispatch ${manifest.dispatchId}, not ${dispatchId}.`);
  }
  if (attempt !== null && Number(manifest.attempt) !== Number(attempt)) {
    fail(`Evidence is from attempt ${manifest.attempt}, not ${attempt}.`);
  }
  if (commitSha && manifest.commitSha && manifest.commitSha !== commitSha) {
    fail(`Evidence was produced against commit ${short(manifest.commitSha)}, but the tree is now ${short(commitSha)}.`);
  }
  if (commitSha && !manifest.commitSha) {
    fail("Evidence records no commit, so it cannot be tied to the reviewed tree.");
  }

  // Artifacts must still be present, contained, and byte-identical.
  for (const artifact of Array.isArray(manifest.artifacts) ? manifest.artifacts : []) {
    let abs;
    try {
      abs = resolveContainedPath(state.worktree, artifact.path);
    } catch (error) {
      fail(String(error.message || error));
      continue;
    }
    if (!existsSync(abs)) {
      fail(`Evidence artifact is missing: ${artifact.path}`);
      continue;
    }
    const stat = statSync(abs);
    if (!stat.isFile() || stat.size === 0) {
      fail(`Evidence artifact is not a non-empty file: ${artifact.path}`);
      continue;
    }
    if (Number(artifact.bytes) !== stat.size) {
      fail(`Evidence artifact changed size: ${artifact.path}`);
      continue;
    }
    if (artifact.sha256 !== sha256File(abs)) {
      fail(`Evidence artifact was modified after it was recorded: ${artifact.path}`);
    }
  }

  // A criterion may only be called proven by something actually observed.
  for (const criterion of Array.isArray(manifest.criteria) ? manifest.criteria : []) {
    if (criterion.status !== "proven") continue;
    const cited = (criterion.artifacts || [])
      .map((id) => (manifest.artifacts || []).find((a) => a.id === id))
      .filter(Boolean);
    if (!cited.length) {
      fail(`Criterion ${criterion.id} claims proof but cites no artifact.`);
      continue;
    }
    if (criterion.kind === "asserted") {
      fail(`Criterion ${criterion.id} rests on an agent assertion, which cannot prove a criterion.`);
      continue;
    }
    // A command-output proof must carry an exit status the factory observed, and
    // that status must be success. A fabricated log file cannot satisfy this.
    const commandProofs = cited.filter((a) => a.type === "command-output");
    for (const proof of commandProofs) {
      if (!proof.observed) {
        fail(`Criterion ${criterion.id} cites ${proof.path}, whose exit status was never observed by the factory.`);
      } else if (proof.exitStatus !== 0) {
        fail(`Criterion ${criterion.id} cites ${proof.path}, which exited ${proof.exitStatus}.`);
      }
    }
    if (!commandProofs.length && !cited.some((a) => a.type === "manual-scenario" || a.type === "screenshot")) {
      fail(`Criterion ${criterion.id} cites no executable or observable proof.`);
    }
  }

  return { ok: errors.length === 0, errors };
}

function short(sha) {
  return String(sha || "").slice(0, 10);
}

// ── reporting ────────────────────────────────────────────────────────────────

// Summarize what a manifest actually establishes, for the completion report.
// Keeps asserted, observed, and independently verified claims separate so the
// founder is never shown an agent's self-report as if it were a check.
export function summarizeManifest(manifest) {
  const criteria = Array.isArray(manifest?.criteria) ? manifest.criteria : [];
  return {
    stage: manifest?.stage || null,
    verdict: manifest?.verdict || null,
    commitSha: manifest?.commitSha || null,
    proven: criteria.filter((c) => c.status === "proven").length,
    blocked: criteria.filter((c) => c.status === "blocked").length,
    notApplicable: criteria.filter((c) => c.status === "not-applicable").length,
    independentlyVerified: criteria.filter((c) => c.status === "proven" && c.kind === "independently-verified").length,
    asserted: criteria.filter((c) => c.kind === "asserted").length,
    artifacts: Array.isArray(manifest?.artifacts) ? manifest.artifacts.length : 0,
    observedCommands: (manifest?.artifacts || []).filter((a) => a.type === "command-output" && a.observed).length,
    limitations: manifest?.limitations || null,
  };
}
