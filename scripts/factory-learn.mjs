#!/usr/bin/env node
// Company Learning System adapter.
//
// One JSON request in (stdin, --request <file>, inline JSON, or --flags), one
// JSON response out — same contract as scripts/openclaw-factory.mjs and
// scripts/project-intel.mjs. No daemon. Read-only over project repos; the only
// repo writes are learning/* proposal branches, and those go through git
// worktrees.
//
// Actions: analyze | list | digest | synthesize | promote | dismiss | prune | research
//
// The workflow engine (factory/lib/task-workflow.mjs, the state machine, the
// pipeline) is not imported or modified.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { collectTaskRecords, defaultFactoryStateRoot } from "../factory/lib/learning/evidence.mjs";
import { analyzeTasks } from "../factory/lib/learning/analyze.mjs";
import {
  learningRootFor, readQueue, writeQueue, reconcile, setStatus, selectFindings, findById, pruneEvidence,
} from "../factory/lib/learning/queue.mjs";
import {
  KNOWLEDGE_DIR, KNOWLEDGE_FILES, knowledgeFilePath, appendEntryToBody, entryFromFinding,
} from "../factory/lib/learning/knowledge.mjs";
import { synthesize, renderProposalsCommitBody } from "../factory/lib/learning/synthesize.mjs";
import { publishProposals, branchName } from "../factory/lib/learning/publish.mjs";
import { runResearch, renderResearchNoteMarkdown } from "../factory/lib/learning/research.mjs";
import { computeFactoryMetrics, diffMetrics, renderMetricsDigest } from "../factory/lib/learning/metrics.mjs";
import {
  DEFAULT_ROTATION, ROLE_TARGET, readMasteryState, pickDeepDiveRoles, roleRecords,
  masteryFindings, renderMasteryLogEntry, insertMasteryLogEntry, dossierHeader, runMasteryPass,
} from "../factory/lib/learning/mastery.mjs";
import { slugify } from "../factory/lib/common/fingerprint.mjs";

const hqRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  try {
    const request = await readRequest(process.argv.slice(2));
    const response = await handleRequest(request);
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ version: 1, status: "error", error: error.message || String(error) }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

function config() {
  try {
    return JSON.parse(readFileSync(join(hqRoot, "factory", "factory.config.json"), "utf8"));
  } catch {
    return {};
  }
}

function stateRootFor(request) {
  return resolve(request.stateRoot || defaultFactoryStateRoot(hqRoot));
}

function nowFor(request) {
  return request.now || new Date().toISOString();
}

export async function handleRequest(request, deps = {}) {
  if (!request || request.version !== 1) throw new Error("Unsupported or missing request version.");
  switch (request.action) {
    case "analyze": return analyze(request);
    case "list": return list(request);
    case "digest": return digest(request);
    case "synthesize": return synthesizeAction(request, deps);
    case "promote": return promote(request, deps);
    case "cycle": return cycle(request, deps);
    case "dismiss": return dismiss(request);
    case "prune": return prune(request);
    case "research": return research(request, deps);
    default: throw new Error(`Unsupported action: ${request.action}`);
  }
}

function analyze(request) {
  const stateRoot = stateRootFor(request);
  const learningRoot = learningRootFor(stateRoot);
  const now = nowFor(request);
  const maxAttemptsPerStage = config().openclawIntegration?.maxAttemptsPerStage || 3;
  const { records, skipped } = collectTaskRecords({
    factoryStateRoot: stateRoot,
    project: request.project || null,
    since: request.since || null,
    includeActive: request.includeActive === true,
  });
  const filtered = request.task ? records.filter((r) => r.id === request.task) : records;
  const analysis = analyzeTasks(filtered, { now, maxAttemptsPerStage });
  const incoming = [...analysis.failures, ...analysis.successes, ...analysis.patterns, ...analysis.agentImprovements];
  const { store, added, updated, recurred } = reconcile(readQueue(learningRoot), incoming, { now });
  writeQueue(learningRoot, store);

  const runsDir = join(learningRoot, "runs");
  mkdirSync(runsDir, { recursive: true });
  const runPath = join(runsDir, `${now.replace(/[:.]/g, "-")}.json`);
  writeFileSync(runPath, `${JSON.stringify({ version: 1, generatedAt: now, analysis, skipped, added, updated, recurred }, null, 2)}\n`, "utf8");

  return {
    version: 1,
    status: "ok",
    analyzedTasks: analysis.analyzedTasks,
    skipped,
    findings: {
      failures: analysis.failures.length,
      successes: analysis.successes.length,
      patterns: analysis.patterns.length,
      agentImprovements: analysis.agentImprovements.length,
    },
    queue: { added, updated, recurred, open: selectFindings(store, { status: "open" }).length },
    runPath,
  };
}

function list(request) {
  const learningRoot = learningRootFor(stateRootFor(request));
  const store = readQueue(learningRoot);
  const findings = selectFindings(store, {
    kind: request.kind || null,
    scope: request.scope || null,
    status: request.status === "any" ? null : (request.status || "open"),
    project: request.project || null,
  });
  return { version: 1, status: "ok", count: findings.length, findings };
}

function latestRunAnalysis(learningRoot) {
  try {
    const runsDir = join(learningRoot, "runs");
    if (!existsSync(runsDir)) return {};
    const files = readdirSync(runsDir).filter((f) => f.endsWith(".json")).sort();
    if (!files.length) return {};
    const last = JSON.parse(readFileSync(join(runsDir, files[files.length - 1]), "utf8"));
    return { analyzedTasks: last.analysis?.analyzedTasks };
  } catch {
    return {};
  }
}

function digest(request) {
  const learningRoot = learningRootFor(stateRootFor(request));
  const store = readQueue(learningRoot);
  const now = nowFor(request);
  const { digest: text } = synthesize({ store, analysis: latestRunAnalysis(learningRoot), now });
  mkdirSync(learningRoot, { recursive: true });
  const digestPath = join(learningRoot, "digest.md");
  writeFileSync(digestPath, `${text}\n`, "utf8");
  return { version: 1, status: "ok", digestPath, text };
}

function mergedKnowledgeFiles(entries, { now }) {
  // entries: [{ fileKey, entry }]  -> [{ path, content }] with proposals appended
  const byKey = {};
  for (const { fileKey, entry } of entries) (byKey[fileKey] ||= []).push(entry);
  const files = [];
  for (const [key, list] of Object.entries(byKey)) {
    const path = knowledgeFilePath(hqRoot, key);
    let body = existsSync(path) ? readFileSync(path, "utf8") : `# ${KNOWLEDGE_FILES[key].title}\n`;
    let appended = 0;
    for (const entry of list) {
      const res = appendEntryToBody(body, entry, { now });
      body = res.body;
      if (res.appended) appended += 1;
    }
    if (appended) files.push({ path: `${KNOWLEDGE_DIR}/${KNOWLEDGE_FILES[key].file}`, content: body, appended });
  }
  return files;
}

async function synthesizeAction(request, deps) {
  const stateRoot = stateRootFor(request);
  const learningRoot = learningRootFor(stateRoot);
  const now = nowFor(request);
  const store = readQueue(learningRoot);
  const { proposals, digest: digestText } = synthesize({ store, analysis: {}, now });

  const proposalsDir = join(learningRoot, "proposals", now.replace(/[:.]/g, "-"));
  mkdirSync(proposalsDir, { recursive: true });
  writeFileSync(join(proposalsDir, "digest.md"), `${digestText}\n`, "utf8");
  writeFileSync(join(proposalsDir, "proposals.json"), `${JSON.stringify({ version: 1, generatedAt: now, proposals }, null, 2)}\n`, "utf8");
  mkdirSync(learningRoot, { recursive: true });
  writeFileSync(join(learningRoot, "digest.md"), `${digestText}\n`, "utf8");

  // Candidate knowledge-file bodies (existing file + proposed entries appended).
  // Always written to the runtime proposals dir for inspection. Never touches the
  // repo unless `publish: true` is explicitly requested.
  const files = mergedKnowledgeFiles(proposals.map((p) => ({ fileKey: p.fileKey, entry: p.entry })), { now });
  for (const f of files) {
    writeFileSync(join(proposalsDir, f.path.replace(/\//g, "__")), f.content, "utf8");
  }

  let publication;
  if (!proposals.length) {
    publication = { published: false, reason: "no open findings to propose" };
  } else if (!files.length) {
    publication = { published: false, reason: "every proposed entry is already present in the knowledge files" };
  } else if (request.publish === true) {
    const publishImpl = deps.publishProposals || publishProposals;
    publication = publishImpl({
      hqRoot,
      branch: request.branch || branchName(now, "proposals"),
      files: files.map((f) => ({ path: f.path, content: f.content })),
      commitTitle: `learning: proposals ${now.slice(0, 10)}`,
      commitBody: renderProposalsCommitBody(proposals, { now }),
      prTitle: `Learning proposals — ${now.slice(0, 10)}`,
      prBody: `${renderProposalsCommitBody(proposals, { now })}\n\nSource: \`npm run factory:learn -- synthesize --publish\`. Digest in \`_learning/digest.md\`.`,
      now,
    });
  } else {
    publication = {
      published: false,
      reason: "dry run — re-run with --publish (or {\"publish\":true}) to open the learning/* branch and PR",
      wouldPublish: files.map((f) => f.path),
      branch: request.branch || branchName(now, "proposals"),
    };
  }

  return {
    version: 1,
    status: "ok",
    proposals: proposals.map((p) => ({ findingId: p.findingId, file: p.file, title: p.entry.title })),
    proposalsDir,
    digestPath: join(learningRoot, "digest.md"),
    publication,
  };
}

function scaffoldFactoryTask(finding, { now }) {
  const id = `learn-${slugify(finding.id)}-${now.slice(0, 10).replace(/-/g, "")}`.slice(0, 40);
  const isPromptOrGate = /builder|reviewer|qa|security|architect|product|release/.test(finding.targetRole || "") || finding.kind === "agent-improvement";
  return {
    id,
    issue: `local:${id}`,
    outcome: `Apply learning finding ${finding.id}: ${finding.title}. ${finding.recommendation}`,
    acceptanceCriteria: [
      `The change reflects the recommendation from finding ${finding.id}.`,
      "Affected role prompt / config / rules doc is updated and internally consistent.",
      "npm run test:factory passes.",
    ],
    project: "openclaw-factory",
    workType: isPromptOrGate ? "ops" : "architecture",
    risk: "low",
    preferredBuilder: "auto",
    constraints: [
      "Do not modify the workflow engine (factory/lib/task-workflow.mjs) or the pipeline.",
      "Documentation / prompt / config change only unless the finding explicitly requires code.",
      `Source finding evidence tasks: ${finding.taskIds.join(", ") || "n/a"}`,
    ],
  };
}

function promote(request, deps) {
  if (!request.id) throw new Error("promote requires an id.");
  const stateRoot = stateRootFor(request);
  const learningRoot = learningRootFor(stateRoot);
  const now = nowFor(request);
  const store = readQueue(learningRoot);
  const finding = findById(store, request.id);
  if (!finding) throw new Error(`No such finding: ${request.id}`);
  if (finding.status !== "open") throw new Error(`Finding ${request.id} is ${finding.status}, not open.`);

  const wantTask = request.as === "task" ||
    (request.as !== "entry" && (finding.kind === "agent-improvement" || /prompt|gate|routing/i.test(finding.recommendation || "")));

  const outputs = {};
  let changeStatus = true;

  if (wantTask) {
    // Local only: write a pre-filled low-risk task contract for the founder to
    // run through the normal factory. Safe to do without opt-in.
    const contract = scaffoldFactoryTask(finding, { now });
    const tasksDir = join(learningRoot, "proposals", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    const contractPath = join(tasksDir, `${contract.id}.json`);
    writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`, "utf8");
    outputs.taskContractPath = contractPath;
    outputs.next = `node scripts/openclaw-factory.mjs init with contractPath=${contractPath}`;
  } else {
    const entry = entryFromFinding(finding, { now });
    const files = mergedKnowledgeFiles([{ fileKey: entry.fileKey, entry }], { now });
    if (!files.length) {
      outputs.knowledge = "entry already present in the knowledge file";
      changeStatus = false;
    } else {
      const candidateDir = join(learningRoot, "proposals", "promote");
      mkdirSync(candidateDir, { recursive: true });
      const candidatePath = join(candidateDir, `${finding.id}__${KNOWLEDGE_FILES[entry.fileKey].file}`);
      writeFileSync(candidatePath, files[0].content, "utf8");
      outputs.candidatePath = candidatePath;
      outputs.file = files[0].path;
      if (request.publish === true) {
        const publishImpl = deps.publishProposals || publishProposals;
        outputs.publication = publishImpl({
          hqRoot,
          branch: request.branch || branchName(now, slugify(finding.id)),
          files: files.map((f) => ({ path: f.path, content: f.content })),
          commitTitle: `learning: promote ${finding.id} — ${entry.title}`,
          commitBody: `Promotes learning finding ${finding.id} into ${KNOWLEDGE_FILES[entry.fileKey].file}.\nEvidence tasks: ${finding.taskIds.join(", ") || "n/a"}`,
          prTitle: `Learning: ${entry.title}`,
          prBody: `Promotes finding \`${finding.id}\`.\n\n${finding.observation}\n\n**Recommendation:** ${finding.recommendation}`,
          now,
        });
      } else {
        outputs.publication = {
          published: false,
          reason: "dry run — re-run with --publish (or {\"publish\":true}) to open the learning/* branch and PR",
        };
        changeStatus = false;
      }
    }
  }

  if (changeStatus) {
    const { store: updated } = setStatus(store, request.id, "promoted", {
      reason: wantTask ? "scaffolded factory task" : "appended knowledge entry",
      now,
    });
    writeQueue(learningRoot, updated);
  }
  return {
    version: 1,
    status: "ok",
    promoted: changeStatus ? request.id : null,
    dryRun: !changeStatus,
    mode: wantTask ? "task" : "entry",
    ...outputs,
  };
}

function dismiss(request) {
  if (!request.id) throw new Error("dismiss requires an id.");
  if (!request.reason) throw new Error("dismiss requires a reason.");
  const learningRoot = learningRootFor(stateRootFor(request));
  const store = readQueue(learningRoot);
  const { store: updated, finding } = setStatus(store, request.id, "dismissed", { reason: request.reason, now: nowFor(request) });
  writeQueue(learningRoot, updated);
  return { version: 1, status: "ok", dismissed: request.id, title: finding.title };
}

function prune(request) {
  const learningRoot = learningRootFor(stateRootFor(request));
  const store = readQueue(learningRoot);
  const { store: updated, pruned } = pruneEvidence(store, { days: Number(request.days) || 90, now: nowFor(request) });
  writeQueue(learningRoot, updated);
  return { version: 1, status: "ok", pruned };
}

async function research(request, deps) {
  if (!request.topic) throw new Error("research requires a topic.");
  const stateRoot = stateRootFor(request);
  const learningRoot = learningRootFor(stateRoot);
  const now = nowFor(request);
  let agendaContext = "";
  const agendaPath = join(hqRoot, "factory", "knowledge", "research-agenda.md");
  if (existsSync(agendaPath)) agendaContext = readFileSync(agendaPath, "utf8").slice(0, 4000);
  const agentId = config().openclawIntegration?.agentIds?.learning || "learning";
  const note = await runResearch({
    topic: request.topic,
    agendaContext,
    agentId,
    now,
    execute: deps.executeResearch,
  });
  const dir = join(learningRoot, "research");
  mkdirSync(dir, { recursive: true });
  const notePath = join(dir, `${now.slice(0, 10)}-${slugify(request.topic)}.json`);
  writeFileSync(notePath, `${JSON.stringify({ version: 1, ...note }, null, 2)}\n`, "utf8");
  writeFileSync(notePath.replace(/\.json$/, ".md"), `${renderResearchNoteMarkdown(note)}\n`, "utf8");
  return { version: 1, status: "ok", note, notePath };
}

// ---- cycle: the scheduled 3-day retrospective + mastery pass ---------------
//
// One run does: (1) retrospective analysis + performance metrics over recent
// terminal tasks; (2) a mastery pass on the next role in the rotation, always,
// even when nothing failed; (3) synthesize proposals; (4) for whitelisted
// categories, open an auto-merge-candidate PR (capped); everything else stays an
// open finding for the founder. Governed by factory.config.json -> learning.autonomy.
// See docs/software-factory/DECISIONS.md SFD-2026-008.

function readJsonSafe(path) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  } catch {
    return null;
  }
}

function appendJsonl(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(obj)}\n`, { flag: "a" });
}

// Synthesized proposals are always knowledge-file appends today (including the
// mastery pass's PROCESS_IMPROVEMENTS entries). prompt-wording / new-skill are
// reserved for future emitters and never auto-eligible until one exists.
function categorizeProposal() {
  return "knowledge-append";
}

async function cycle(request, deps = {}) {
  const stateRoot = stateRootFor(request);
  const learningRoot = learningRootFor(stateRoot);
  const now = nowFor(request);
  const cfg = config();
  const autonomy = cfg.learning?.autonomy || {};
  const maxAttemptsPerStage = cfg.openclawIntegration?.maxAttemptsPerStage || 3;
  const lookbackDays = Number(request.lookbackDays) || autonomy.lookbackDays || 30;
  const since = request.since || new Date(Date.parse(now) - lookbackDays * 86400000).toISOString();

  // (1) retrospective ------------------------------------------------------
  const { records, skipped } = collectTaskRecords({ factoryStateRoot: stateRoot, since });
  const analysis = analyzeTasks(records, { now, maxAttemptsPerStage });
  const metrics = computeFactoryMetrics(records, { now });
  const prev = readJsonSafe(join(learningRoot, "metrics.json"));
  const metricsDelta = diffMetrics(prev?.metrics, metrics);

  // (2) mastery pass (always runs) --------------------------------------
  const masteryState = readMasteryState(learningRoot);
  const rotation = Array.isArray(autonomy.mastery?.rotation) && autonomy.mastery.rotation.length
    ? autonomy.mastery.rotation
    : DEFAULT_ROTATION;
  const deepDiveCount = autonomy.mastery?.deepDiveRolesPerCycle || 1;
  const { roles: deepDiveRoles, nextCursor } = pickDeepDiveRoles(masteryState, { rotation, count: deepDiveCount });
  const researchBudget = Number(request.researchCalls ?? autonomy.research?.maxCallsPerRun ?? 10);
  const learningAgentId = cfg.openclawIntegration?.agentIds?.learning || "learning";

  const masteryResults = [];
  let researchUsed = 0;
  for (const role of deepDiveRoles) {
    if (researchUsed >= researchBudget) break;
    const res = await runMasteryPass({
      role, records, hqRoot, now, agentId: learningAgentId, execute: deps.executeResearch,
    });
    if (res.note) researchUsed += 1;
    masteryResults.push(res);
  }

  // (3) reconcile all findings --------------------------------------------
  const roleMetricsFor = (role) => metrics.perRole?.[role] || metrics.perRole?.[ROLE_TARGET[role]] || null;
  const incoming = [
    ...analysis.failures, ...analysis.successes, ...analysis.patterns, ...analysis.agentImprovements,
  ];
  for (const mr of masteryResults) {
    if (!mr.note) continue;
    incoming.push(...masteryFindings({ role: mr.role, note: mr.note, roleMetrics: roleMetricsFor(mr.role), now }));
  }
  let { store, added, updated, recurred } = reconcile(readQueue(learningRoot), incoming, { now });
  writeQueue(learningRoot, store);

  // dossier append per deep-dive role (a knowledge-append style write)
  const dossierWrites = [];
  for (const mr of masteryResults) {
    const rel = `${KNOWLEDGE_DIR}/agents/${mr.role}.md`;
    const abs = join(hqRoot, rel);
    const body = existsSync(abs) ? readFileSync(abs, "utf8") : dossierHeader(mr.role);
    const findingIds = added.filter((id) => (findById(store, id)?.title || "").startsWith(`Mastery (${mr.role})`));
    const entry = renderMasteryLogEntry({
      role: mr.role, date: now.slice(0, 10), roleMetrics: roleMetricsFor(mr.role),
      note: mr.note, error: mr.error, findingIds,
    });
    dossierWrites.push({ path: rel, content: insertMasteryLogEntry(body, entry, mr.role) });
  }

  // (4) synthesize + gated implement -----------------------------------
  const { proposals, digest: baseDigest } = synthesize({
    store, analysis: { analyzedTasks: analysis.analyzedTasks }, now,
  });
  const digestText = `${baseDigest}\n\n${renderMetricsDigest(metrics, metricsDelta)}`;

  const whitelist = new Set(autonomy.whitelist || []);
  const autonomyEnabled = autonomy.enabled === true;
  const maxAuto = Number(autonomy.maxAutoMergesPerRun ?? 2);

  const decisions = [];
  const autoProposals = [];
  for (const p of proposals) {
    const category = categorizeProposal(p);
    const eligible = autonomyEnabled && whitelist.has(category) && autoProposals.length < maxAuto;
    decisions.push({ findingId: p.findingId, file: p.file, category, action: eligible ? "auto" : "propose" });
    if (eligible) autoProposals.push(p);
  }

  const autoFiles = [
    ...mergedKnowledgeFiles(autoProposals.map((p) => ({ fileKey: p.fileKey, entry: p.entry })), { now }),
    ...dossierWrites,
  ];

  let publication = { published: false, reason: autonomyEnabled ? "no whitelisted proposals this cycle" : "autonomy disabled — proposal-only" };
  if (autonomyEnabled && autoFiles.length) {
    const publishImpl = deps.publishProposals || publishProposals;
    try {
      publication = publishImpl({
        hqRoot,
        branch: request.branch || branchName(now, "mastery-cycle"),
        files: autoFiles.map((f) => ({ path: f.path, content: f.content })),
        commitTitle: `learning(cycle): ${now.slice(0, 10)} — ${autoProposals.length} knowledge, ${dossierWrites.length} dossier`,
        commitBody: [
          renderProposalsCommitBody(autoProposals, { now }),
          "",
          `Autonomous learning cycle per SFD-2026-008. Whitelisted categories only: ${[...whitelist].join(", ") || "none"}.`,
          `Deep-dive role(s): ${deepDiveRoles.join(", ")}. Auto cap: ${maxAuto}/run. Non-whitelisted findings stay open for founder review.`,
          "Every entry is Status: proposed — the factory pipeline gates this PR before merge.",
        ].join("\n"),
        prTitle: `Learning cycle — ${now.slice(0, 10)}`,
        prBody: `Autonomous learning + mastery cycle.\n\n${digestText}`,
        now,
      });
    } catch (error) {
      publication = { published: false, reason: `publish failed: ${error.message || error}` };
    }
    if (publication.published || publication.pushed || publication.committed) {
      for (const p of autoProposals) {
        ({ store } = setStatus(store, p.findingId, "promoted", { reason: "autonomous cycle", actor: "learning", now }));
      }
      writeQueue(learningRoot, store);
    }
  }

  // (5) persist run artifacts -----------------------------------------
  mkdirSync(learningRoot, { recursive: true });
  writeFileSync(join(learningRoot, "digest.md"), `${digestText}\n`, "utf8");
  writeFileSync(join(learningRoot, "metrics.json"), `${JSON.stringify({ version: 1, generatedAt: now, metrics, metricsDelta }, null, 2)}\n`, "utf8");
  writeFileSync(join(learningRoot, "mastery-state.json"), `${JSON.stringify({
    version: 1, cursor: nextCursor,
    history: [...(masteryState.history || []), { at: now, roles: deepDiveRoles }].slice(-50),
  }, null, 2)}\n`, "utf8");

  const publicationSummary = {
    published: !!(publication.published || publication.pushed || publication.committed),
    branch: publication.branch || null,
    prUrl: publication.prUrl || null,
    reason: publication.reason || null,
    notes: publication.notes || [],
  };
  appendJsonl(join(learningRoot, "autonomy-log.jsonl"), {
    at: now, since, analyzedTasks: analysis.analyzedTasks,
    deepDiveRoles, researchUsed, researchBudget,
    queue: { added: added.length, updated: updated.length, recurred: recurred.length },
    autoProposals: autoProposals.map((p) => p.findingId), maxAuto,
    decisions, publication: publicationSummary,
  });

  const runsDir = join(learningRoot, "runs");
  mkdirSync(runsDir, { recursive: true });
  const runPath = join(runsDir, `${now.replace(/[:.]/g, "-")}.json`);
  writeFileSync(runPath, `${JSON.stringify({
    version: 1, kind: "cycle", generatedAt: now, since,
    analysis, metrics, metricsDelta,
    mastery: masteryResults.map((m) => ({ role: m.role, topic: m.topic, hasNote: !!m.note, error: m.error, recentCount: m.recentCount })),
    decisions, publication: publicationSummary, skipped,
  }, null, 2)}\n`, "utf8");

  return {
    version: 1,
    status: "ok",
    analyzedTasks: analysis.analyzedTasks,
    metrics: { cycleP50Ms: metrics.cycle.p50Ms, firstPassRate: metrics.firstPassRate, blockedRate: metrics.blockedRate },
    deepDiveRoles,
    researchUsed,
    queue: { added, updated, recurred, open: selectFindings(store, { status: "open" }).length },
    autonomy: { enabled: autonomyEnabled, cap: maxAuto, autoProposals: autoProposals.map((p) => p.findingId), decisions },
    publication: publicationSummary,
    digestPath: join(learningRoot, "digest.md"),
    runPath,
  };
}

// ---- request parsing (mirrors scripts/project-intel.mjs) --------------------

function requestFromFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else { out[key] = next; i += 1; }
    } else if (!out.action) {
      out.action = arg;
    }
  }
  if (out.publish === "false") out.publish = false;
  if (out.includeActive === "true") out.includeActive = true;
  return out;
}

function readRequest(argv) {
  if (argv[0] === "--request" && argv[1]) return JSON.parse(readFileSync(resolve(argv[1]), "utf8"));
  if (argv[0] && argv[0].trim().startsWith("{")) return JSON.parse(argv[0]);
  if (argv[0] && !argv[0].startsWith("-")) return { version: 1, ...requestFromFlags(argv) };
  if (process.stdin.isTTY) return { version: 1, ...requestFromFlags(argv) };
  const chunks = [];
  process.stdin.setEncoding("utf8");
  return new Promise((resolveRequest, reject) => {
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => {
      const body = chunks.join("").trim();
      if (!body) return resolveRequest({ version: 1, ...requestFromFlags(argv) });
      try { resolveRequest(JSON.parse(body)); } catch (error) { reject(new Error(`Invalid JSON request: ${error.message}`)); }
    });
  });
}
