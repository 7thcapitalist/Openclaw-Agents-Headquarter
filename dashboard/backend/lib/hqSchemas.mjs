import { z } from "zod";
import { AGENT_LIFECYCLE_STATUSES } from "./agentLifecycle.mjs";

export const slugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, "Use lowercase letters, numbers, and hyphens.");

const nullableSlug = slugSchema.nullable().optional();
const stringArray = z.array(z.string().min(1)).default([]);

export const lifecycleStatusSchema = z.enum(AGENT_LIFECYCLE_STATUSES);

export const projectSchema = z
  .object({
    id: slugSchema,
    name: z.string().min(1),
    description: z.string().min(1),
    mission: z.string().min(1),
    currentStatus: z.string().min(1),
    currentPhase: z.string().min(1),
    currentGoals: stringArray,
    keyMetrics: stringArray,
    mainWorkflows: stringArray,
    existingAssets: stringArray,
    currentBlockers: stringArray,
    relatedAgents: stringArray,
    approvalRules: stringArray,
    nextRecommendedActions: stringArray,
    projectCEO: slugSchema,
    mainMetric: z.string().min(1),
    bottleneck: z.string().min(1),
    latestReport: z.string().min(1),
  })
  .passthrough();

export const hqAgentSchema = z
  .object({
    id: slugSchema,
    name: z.string().min(1),
    role: z.string().min(1),
    division: z.string().min(1),
    layer: z.enum(["global-hq", "project-ceo", "existing-agent"]),
    projectId: nullableSlug,
    reportsTo: nullableSlug,
    manages: z.array(slugSchema).default([]),
    status: lifecycleStatusSchema.default("designed"),
    lifecycleStatus: lifecycleStatusSchema.optional(),
    currentTask: z.string().default(""),
    lastOutput: z.string().default(""),
    approvalPermissions: stringArray,
    tools: stringArray,
    existingAgentKey: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/)
      .optional(),
    description: z.string().min(1),
  })
  .passthrough();

export const taskSchema = z
  .object({
    id: slugSchema,
    title: z.string().min(1),
    projectId: slugSchema,
    assignedAgent: slugSchema,
    requestedBy: slugSchema,
    priority: z.enum(["Low", "Medium", "High", "Urgent"]),
    status: z.enum(["Inbox", "Assigned", "In Progress", "Review", "Done", "Blocked"]),
    dueDate: z.string().default(""),
    expectedOutput: z.string().min(1),
    approvalRequired: z.boolean(),
    blocker: z.string().default(""),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .passthrough();

export const sopSchema = z
  .object({
    id: slugSchema,
    scope: z.enum(["global", "project"]),
    projectId: nullableSlug,
    title: z.string().min(1),
    ownerAgent: slugSchema,
    body: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .passthrough();

export const reportSchema = z
  .object({
    id: slugSchema,
    type: z.enum(["daily-brief", "project-ceo-report", "weekly-project-review"]),
    projectId: nullableSlug,
    agentId: slugSchema,
    title: z.string().min(1),
    summary: z.string().min(1),
    body: z.string().min(1),
    createdAt: z.string().min(1),
  })
  .passthrough();

export const logSchema = z
  .object({
    id: slugSchema,
    type: z.enum(["daily", "decision", "task", "error", "agent-run"]),
    projectId: nullableSlug,
    agentId: nullableSlug,
    taskId: nullableSlug,
    title: z.string().min(1),
    detail: z.string().min(1),
    source: z.string().min(1),
    createdAt: z.string().min(1),
  })
  .passthrough();

const collectionSchemas = {
  agents: z.array(hqAgentSchema),
  tasks: z.array(taskSchema),
  sops: z.array(sopSchema),
  reports: z.array(reportSchema),
  logs: z.array(logSchema),
};

export function parseProjectForWrite(routeId, value) {
  if (value?.id && value.id !== routeId) {
    throw new Error("Project id must match route id.");
  }
  const parsed = projectSchema.parse({ ...value, id: routeId });
  return parsed;
}

export function parseCollectionForWrite(name, value) {
  const schema = collectionSchemas[name];
  if (!schema) throw new Error("Unknown HQ collection");
  return schema.parse(value);
}

export function formatZodError(error) {
  if (!(error instanceof z.ZodError)) return String(error?.message || error);
  return error.issues
    .map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`)
    .join("; ");
}
