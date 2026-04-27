/**
 * Route handlers for work item (task queue) operations.
 *
 * Exposes all work item CRUD and lifecycle operations over HTTP,
 * sharing business logic with the handlers in
 * `daemon/handlers/work-items.ts`.
 */
import { z } from "zod";

import type { Conversation } from "../../daemon/conversation.js";
import { findConversation } from "../../daemon/conversation-store.js";
import type { ServerMessage } from "../../daemon/message-protocol.js";
import { getMessages } from "../../memory/conversation-crud.js";
import { check, classifyRisk } from "../../permissions/checker.js";
import { getSubagentManager } from "../../subagent/index.js";
import { runTask } from "../../tasks/task-runner.js";
import { getTask, getTaskRun } from "../../tasks/task-store.js";
import {
  getRegisteredToolNames,
  getToolDescription,
  sanitizeToolList,
} from "../../tasks/tool-sanitizer.js";
import { createAbortReason } from "../../util/abort-reasons.js";
import { getLogger } from "../../util/logger.js";
import { truncate } from "../../util/truncate.js";
import { resolveRequiredTools } from "../../work-items/resolve-required-tools.js";
import {
  deleteWorkItem,
  getWorkItem,
  listWorkItems,
  updateWorkItem,
  type WorkItemStatus,
} from "../../work-items/work-item-store.js";
import { buildAssistantEvent } from "../assistant-event.js";
import { assistantEventHub } from "../assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../assistant-scope.js";
import { httpError } from "../http-errors.js";
import type { HTTPRouteDefinition } from "../http-router.js";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

const log = getLogger("work-items-routes");

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function publishEvent(msg: ServerMessage): void {
  void assistantEventHub.publish(
    buildAssistantEvent(DAEMON_INTERNAL_ASSISTANT_ID, msg),
  );
}

function broadcastWorkItemStatus(id: string): void {
  const item = getWorkItem(id);
  if (item) {
    publishEvent({
      type: "work_item_status_changed",
      item: {
        id: item.id,
        taskId: item.taskId,
        title: item.title,
        status: item.status,
        lastRunId: item.lastRunId,
        lastRunConversationId: item.lastRunConversationId,
        lastRunStatus: item.lastRunStatus,
        updatedAt: item.updatedAt,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Shared business logic: extracting output from a work item run
// ---------------------------------------------------------------------------

/**
 * Extract only the latest assistant text block from stored content.
 * Consolidation merges multiple assistant messages into one DB row; scanning
 * from the end keeps task output focused on the final assistant response.
 */
function extractLatestTextFromContent(content: string): string {
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      for (let i = parsed.length - 1; i >= 0; i--) {
        const block = parsed[i] as { type?: unknown; text?: unknown };
        if (block.type !== "text") continue;
        if (typeof block.text !== "string") continue;
        if (!block.text.trim()) continue;
        return block.text;
      }
      return "";
    }
  } catch {
    // Plain text content — use as-is
  }
  return content;
}

/** Extract tool_result blocks from a user message's content. */
function extractToolResults(
  content: string,
): Array<{ tool_use_id: string; content: string; is_error?: boolean }> {
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((b: { type: string }) => b.type === "tool_result")
        .map(
          (b: {
            tool_use_id: string;
            content?: string | Array<{ type: string; text?: string }>;
            is_error?: boolean;
          }) => {
            let text = "";
            if (typeof b.content === "string") {
              text = b.content;
            } else if (Array.isArray(b.content)) {
              text = b.content
                .filter((c) => c.type === "text" && c.text)
                .map((c) => c.text!)
                .join("\n");
            }
            return {
              tool_use_id: b.tool_use_id,
              content: text,
              is_error: b.is_error,
            };
          },
        );
    }
  } catch {
    // Not JSON — no tool_result blocks
  }
  return [];
}

/**
 * Build highlights from tool outcomes in the conversation. Scans for
 * tool_use (assistant) and tool_result (user) pairs, extracting concrete
 * outcomes like errors, file paths, and URLs.
 */
function extractToolHighlights(
  msgs: Array<{ role: string; content: string }>,
  maxHighlights: number,
): string[] {
  const highlights: string[] = [];

  // Build a map of tool_use_id -> tool name from assistant messages
  const toolNameById = new Map<string, string>();
  for (const m of msgs) {
    if (m.role !== "assistant") continue;
    try {
      const parsed = JSON.parse(m.content);
      if (Array.isArray(parsed)) {
        for (const block of parsed) {
          if (block.type === "tool_use" && block.id && block.name) {
            toolNameById.set(block.id, block.name);
          }
        }
      }
    } catch {
      /* skip */
    }
  }

  // Scan tool_result messages in reverse order (most recent first)
  for (
    let i = msgs.length - 1;
    i >= 0 && highlights.length < maxHighlights;
    i--
  ) {
    const m = msgs[i];
    if (m.role !== "user") continue;

    const results = extractToolResults(m.content);
    for (const result of results) {
      if (highlights.length >= maxHighlights) break;

      const toolName = toolNameById.get(result.tool_use_id) ?? "tool";
      const resultText = result.content.trim();

      if (result.is_error) {
        // Always surface errors
        const errorSnippet = truncate(resultText, 200, "...");
        highlights.push(`- ${toolName}: Error — ${errorSnippet}`);
      } else if (resultText) {
        // Extract notable signal from successful results: file paths, URLs, or
        // a short summary of what happened
        const firstLine = resultText.split("\n")[0].trim();
        if (firstLine.length > 0 && firstLine.length <= 200) {
          highlights.push(`- ${toolName}: ${firstLine}`);
        } else if (firstLine.length > 200) {
          highlights.push(`- ${toolName}: ${truncate(firstLine, 200, "...")}`);
        }
      }
    }
  }

  return highlights;
}

// ---------------------------------------------------------------------------
// Shared business logic functions (exported for handler reuse)
// ---------------------------------------------------------------------------

export interface WorkItemOutputResult {
  success: boolean;
  error?: string;
  output?: {
    title: string;
    status: string;
    runId: string | null;
    conversationId: string | null;
    completedAt: number | null;
    summary: string;
    highlights: string[];
  };
}

function getWorkItemOutput(id: string): WorkItemOutputResult {
  const workItem = getWorkItem(id);
  if (!workItem) {
    return { success: false, error: "Work item not found" };
  }

  // Use the task run's conversationId as the authoritative source.
  let conversationId: string | null = null;
  let completedAt: number | null = null;

  if (workItem.lastRunId) {
    const run = getTaskRun(workItem.lastRunId);
    if (run) {
      conversationId = run.conversationId;
      completedAt =
        run.finishedAt != null ? Math.floor(run.finishedAt / 1000) : null;
    }
  }

  // Fall back to the work item's stored conversationId
  if (!conversationId) {
    conversationId = workItem.lastRunConversationId;
  }

  if (!conversationId) {
    return {
      success: false,
      error: "This task has not been run yet. No output is available.",
    };
  }

  let summary = "";
  let highlights: string[] = [];

  const msgs = getMessages(conversationId);

  // Find the last assistant message with text content
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "assistant") continue;

    const text = extractLatestTextFromContent(m.content);
    if (!text.trim()) continue;

    summary = truncate(text, 2000, "");

    // Extract bullet points from the assistant's prose
    const lines = text.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (
        (trimmed.startsWith("-") || trimmed.startsWith("*")) &&
        trimmed.length > 2
      ) {
        highlights.push(trimmed);
        if (highlights.length >= 5) break;
      }
    }
    break;
  }

  // Supplement with tool outcomes
  if (highlights.length < 5) {
    const toolHighlights = extractToolHighlights(msgs, 5 - highlights.length);
    highlights = [...highlights, ...toolHighlights];
  }

  // Synthesize from tool results if no assistant summary
  if (!summary && msgs.length > 0) {
    const toolHighlights = extractToolHighlights(msgs, 10);
    if (toolHighlights.length > 0) {
      summary = "Task completed. Tool outcomes:\n" + toolHighlights.join("\n");
      highlights = toolHighlights.slice(0, 5);
    }
  }

  return {
    success: true,
    output: {
      title: workItem.title,
      status: workItem.lastRunStatus ?? workItem.status,
      runId: workItem.lastRunId,
      conversationId,
      completedAt,
      summary,
      highlights,
    },
  };
}

export interface WorkItemPreflightResult {
  success: boolean;
  error?: string;
  permissions?: Array<{
    tool: string;
    description: string;
    riskLevel: "low" | "medium" | "high";
    currentDecision: "allow" | "deny" | "prompt";
  }>;
}

export async function preflightWorkItem(
  id: string,
): Promise<WorkItemPreflightResult> {
  const workItem = getWorkItem(id);
  if (!workItem) {
    return { success: false, error: "Work item not found" };
  }

  const task = getTask(workItem.taskId);
  if (!task) {
    return {
      success: false,
      error: `Associated task not found: ${workItem.taskId}`,
    };
  }
  const taskRequiredTools = task.requiredTools
    ? sanitizeToolList(JSON.parse(task.requiredTools))
    : getRegisteredToolNames();
  let requiredTools = resolveRequiredTools(
    workItem.requiredTools,
    taskRequiredTools,
  );

  if (requiredTools.length === 0) {
    return { success: true, permissions: [] };
  }

  // Filter out already-approved tools
  if (workItem.approvedTools) {
    const approvedSet = new Set<string>(JSON.parse(workItem.approvedTools));
    requiredTools = requiredTools.filter((t) => !approvedSet.has(t));
    if (requiredTools.length === 0) {
      return { success: true, permissions: [] };
    }
  }

  const workingDir = process.cwd();
  const policyContext = { executionContext: "headless" as const };
  const permissions = await Promise.all(
    requiredTools.map(async (tool) => {
      const { level: risk } = await classifyRisk(tool, {}, workingDir);
      const result = await check(tool, {}, workingDir, policyContext);
      return {
        tool,
        description: getToolDescription(tool),
        riskLevel: risk.toLowerCase() as "low" | "medium" | "high",
        currentDecision: result.decision as "allow" | "deny" | "prompt",
      };
    }),
  );

  return { success: true, permissions };
}

export interface ApprovePermissionsResult {
  success: boolean;
  error?: string;
}

function approveWorkItemPermissions(
  id: string,
  approvedTools: string[],
): ApprovePermissionsResult {
  const workItem = getWorkItem(id);
  if (!workItem) {
    return { success: false, error: "Work item not found" };
  }

  const existingApproved: string[] = workItem.approvedTools
    ? JSON.parse(workItem.approvedTools)
    : [];
  const newApproved = sanitizeToolList(approvedTools);
  const merged = [...new Set([...existingApproved, ...newApproved])];

  updateWorkItem(id, {
    approvedTools: JSON.stringify(sanitizeToolList(merged)),
    approvalStatus: "approved",
  });

  return { success: true };
}

// ---------------------------------------------------------------------------
// Transport-agnostic routes (served by both HTTP and IPC)
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "listWorkItems",
    endpoint: "work-items",
    method: "GET",
    policyKey: "work-items",
    summary: "List work items",
    description: "Return work items, optionally filtered by status.",
    tags: ["work-items"],
    queryParams: [
      {
        name: "status",
        description: "Filter by work item status",
        schema: {
          type: "string",
          enum: [
            "pending",
            "running",
            "awaiting_review",
            "done",
            "failed",
            "cancelled",
            "archived",
          ],
        },
      },
    ],
    responseBody: z.object({
      items: z.array(z.unknown()),
    }),
    handler: ({ queryParams }) => {
      const status = queryParams?.status ?? undefined;
      const items = listWorkItems(
        status ? { status: status as WorkItemStatus } : undefined,
      );
      return { items };
    },
  },

  {
    operationId: "getWorkItem",
    endpoint: "work-items/:id",
    method: "GET",
    policyKey: "work-items",
    summary: "Get a work item",
    description: "Return a single work item by ID.",
    tags: ["work-items"],
    handler: ({ pathParams }) => {
      const item = getWorkItem(pathParams!.id) ?? null;
      if (!item) {
        throw new NotFoundError("Work item not found");
      }
      return { item };
    },
  },

  {
    operationId: "updateWorkItem",
    endpoint: "work-items/:id",
    method: "PATCH",
    policyKey: "work-items",
    summary: "Update a work item",
    description:
      "Partially update a work item's title, notes, status, or priority.",
    tags: ["work-items"],
    requestBody: z.object({
      title: z.string(),
      notes: z.string(),
      status: z.string(),
      priorityTier: z.number().int(),
      sortIndex: z.number().int(),
    }),
    handler: ({ pathParams, body }) => {
      const id = pathParams!.id;
      const { title, notes, status, priorityTier, sortIndex } = (body ??
        {}) as {
        title?: string;
        notes?: string;
        status?: string;
        priorityTier?: number;
        sortIndex?: number;
      };

      if (status !== undefined) {
        const existing = getWorkItem(id);
        if (existing?.status === "cancelled" && status !== "cancelled") {
          return { item: existing };
        }
      }

      const updates: Record<string, unknown> = {};
      if (title !== undefined) updates.title = title;
      if (notes !== undefined) updates.notes = notes;
      if (status !== undefined) updates.status = status;
      if (priorityTier !== undefined) updates.priorityTier = priorityTier;
      if (sortIndex !== undefined) updates.sortIndex = sortIndex;

      const item =
        updateWorkItem(id, updates as Parameters<typeof updateWorkItem>[1]) ??
        null;

      if (item) {
        broadcastWorkItemStatus(item.id);
        publishEvent({ type: "tasks_changed" });
      }

      return { item };
    },
  },

  {
    operationId: "completeWorkItem",
    endpoint: "work-items/:id/complete",
    method: "POST",
    policyKey: "work-items/complete",
    summary: "Complete a work item",
    description: "Transition a work item from awaiting_review to done.",
    tags: ["work-items"],
    handler: ({ pathParams }) => {
      const id = pathParams!.id;
      const existing = getWorkItem(id);
      if (!existing) {
        throw new NotFoundError(`Work item not found: ${id}`);
      }
      if (existing.status !== "awaiting_review") {
        throw new ConflictError(
          `Cannot complete work item: status is '${existing.status}', expected 'awaiting_review'`,
        );
      }

      const item = updateWorkItem(id, { status: "done" }) ?? null;
      if (item) {
        broadcastWorkItemStatus(item.id);
        publishEvent({ type: "tasks_changed" });
      }
      return { item };
    },
  },

  {
    operationId: "deleteWorkItem",
    endpoint: "work-items/:id",
    method: "DELETE",
    policyKey: "work-items",
    summary: "Delete a work item",
    description: "Permanently remove a work item.",
    tags: ["work-items"],
    handler: ({ pathParams }) => {
      const id = pathParams!.id;
      const existing = getWorkItem(id);
      if (!existing) {
        throw new NotFoundError("Work item not found");
      }
      deleteWorkItem(id);
      publishEvent({ type: "tasks_changed" });
      return { id, success: true };
    },
  },

  {
    operationId: "approveWorkItemPermissions",
    endpoint: "work-items/:id/approve-permissions",
    method: "POST",
    policyKey: "work-items/approve-permissions",
    summary: "Approve tool permissions",
    description: "Pre-approve a set of tools for a work item before it runs.",
    tags: ["work-items"],
    requestBody: z.object({
      approvedTools: z
        .array(z.unknown())
        .describe("Array of tool names to approve"),
    }),
    handler: ({ pathParams, body }) => {
      const id = pathParams!.id;
      const { approvedTools } = (body ?? {}) as {
        approvedTools?: string[];
      };
      if (!Array.isArray(approvedTools)) {
        throw new BadRequestError("approvedTools array is required");
      }
      const result = approveWorkItemPermissions(id, approvedTools);
      if (!result.success) {
        throw new NotFoundError(result.error!);
      }
      return { id, success: true };
    },
  },

  {
    operationId: "preflightWorkItem",
    endpoint: "work-items/:id/preflight",
    method: "POST",
    policyKey: "work-items/preflight",
    summary: "Preflight check",
    description: "Check tool permissions needed before running a work item.",
    tags: ["work-items"],
    responseBody: z.object({
      id: z.string(),
      success: z.boolean(),
      permissions: z.object({}).passthrough(),
    }),
    handler: async ({ pathParams }) => {
      const id = pathParams!.id;
      const result = await preflightWorkItem(id);
      if (!result.success) {
        throw new NotFoundError(result.error!);
      }
      return {
        id,
        success: true,
        permissions: result.permissions,
      };
    },
  },

  {
    operationId: "getWorkItemOutput",
    endpoint: "work-items/:id/output",
    method: "GET",
    policyKey: "work-items/output",
    summary: "Get work item output",
    description: "Return the final output of a completed work item run.",
    tags: ["work-items"],
    responseBody: z.object({
      id: z.string(),
      success: z.boolean(),
      output: z.object({}).passthrough(),
    }),
    handler: ({ pathParams }) => {
      const id = pathParams!.id;
      const result = getWorkItemOutput(id);
      if (!result.success) {
        throw new NotFoundError(result.error!);
      }
      return {
        id,
        success: true,
        output: result.output,
      };
    },
  },
];

// ---------------------------------------------------------------------------
// Dependencies for session-bound operations (HTTP-only)
// ---------------------------------------------------------------------------

export interface WorkItemRouteDeps {
  getOrCreateConversation: (conversationId: string) => Promise<Conversation>;
}

// ---------------------------------------------------------------------------
// HTTP-only routes: cancel + run require runtime deps (Conversation closures)
// ---------------------------------------------------------------------------

export function workItemHttpOnlyRouteDefinitions(
  deps?: WorkItemRouteDeps,
): HTTPRouteDefinition[] {
  return [
    {
      endpoint: "work-items/:id/cancel",
      method: "POST",
      policyKey: "work-items/cancel",
      summary: "Cancel a running work item",
      description: "Abort a running work item and set its status to cancelled.",
      tags: ["work-items"],
      handler: ({ params }) => {
        const workItem = getWorkItem(params.id);
        if (!workItem) {
          return httpError("NOT_FOUND", "Work item not found", 404);
        }
        if (workItem.status !== "running") {
          return httpError(
            "CONFLICT",
            `Work item is not running (status: ${workItem.status})`,
            409,
          );
        }

        const conversationId = workItem.lastRunConversationId;
        if (conversationId) {
          const conversation = findConversation(conversationId);
          if (conversation) {
            conversation.headlessLock = false;
            conversation.abort(
              createAbortReason(
                "work_item_aborted",
                "work-items-routes.cancel",
                conversationId,
              ),
            );
            getSubagentManager().abortAllForParent(conversationId);
          }
        }

        updateWorkItem(params.id, {
          status: "cancelled",
          lastRunStatus: "cancelled",
        });

        broadcastWorkItemStatus(params.id);
        publishEvent({ type: "tasks_changed" });
        return Response.json({ id: params.id, success: true });
      },
    },

    {
      endpoint: "work-items/:id/run",
      method: "POST",
      policyKey: "work-items/run",
      summary: "Run a work item",
      description:
        "Execute the task associated with a work item. Returns immediately; execution happens in the background.",
      tags: ["work-items"],
      handler: async ({ params }) => {
        const workItem = getWorkItem(params.id);
        if (!workItem) {
          return httpError("NOT_FOUND", "Work item not found", 404);
        }

        if (workItem.status === "running") {
          return httpError("CONFLICT", "Work item is already running", 409);
        }

        const NON_RUNNABLE_STATUSES: readonly string[] = ["archived"];
        if (NON_RUNNABLE_STATUSES.includes(workItem.status)) {
          return httpError(
            "CONFLICT",
            `Work item has status '${workItem.status}' and cannot be run`,
            409,
          );
        }

        const task = getTask(workItem.taskId);
        if (!task) {
          return httpError(
            "NOT_FOUND",
            `Associated task not found: ${workItem.taskId}`,
            404,
          );
        }

        const taskRequiredTools = task.requiredTools
          ? sanitizeToolList(JSON.parse(task.requiredTools))
          : getRegisteredToolNames();
        const requiredTools = resolveRequiredTools(
          workItem.requiredTools,
          taskRequiredTools,
        );

        let approvedTools: string[] | undefined;
        if (requiredTools.length > 0) {
          approvedTools = workItem.approvedTools
            ? JSON.parse(workItem.approvedTools)
            : undefined;
          const approvedSet = new Set<string>(approvedTools ?? []);
          const missingApprovals = requiredTools.filter(
            (t) => !approvedSet.has(t),
          );
          if (missingApprovals.length > 0) {
            return httpError(
              "FORBIDDEN",
              "Required tool permissions have not been approved. Run preflight first.",
              403,
            );
          }
        }

        if (!deps?.getOrCreateConversation) {
          return httpError(
            "NOT_IMPLEMENTED",
            "Conversation management not available for task execution",
            501,
          );
        }

        updateWorkItem(params.id, { status: "running" });
        broadcastWorkItemStatus(params.id);
        publishEvent({ type: "tasks_changed" });

        let taskConversation: Conversation | null = null;
        const getOrCreateConversation = deps.getOrCreateConversation;
        const workItemId = params.id;

        void (async () => {
          try {
            const result = await runTask(
              {
                taskId: workItem.taskId,
                workingDir: process.cwd(),
                approvedTools,
              },
              async (conversationId, message, taskRunId) => {
                if (!taskConversation) {
                  updateWorkItem(workItemId, {
                    lastRunConversationId: conversationId,
                  });
                  taskConversation =
                    await getOrCreateConversation(conversationId);

                  publishEvent({
                    type: "task_run_conversation_created",
                    conversationId,
                    workItemId,
                    title: workItem.title,
                  });
                  taskConversation.taskRunId = taskRunId;
                  taskConversation.headlessLock = true;
                }
                await taskConversation.processMessage(
                  message,
                  [],
                  (event) => {
                    publishEvent(event);
                  },
                  undefined,
                  undefined,
                  undefined,
                  { isInteractive: false },
                );
              },
            );

            if (taskConversation) {
              (taskConversation as { headlessLock: boolean }).headlessLock =
                false;
            }

            const current = getWorkItem(workItemId);
            if (current?.status !== "cancelled") {
              const finalStatus: WorkItemStatus =
                result.status === "completed" ? "awaiting_review" : "failed";
              updateWorkItem(workItemId, {
                status: finalStatus,
                lastRunId: result.taskRunId,
                lastRunConversationId: result.conversationId,
                lastRunStatus: result.status,
              });
            }

            broadcastWorkItemStatus(workItemId);
            publishEvent({ type: "tasks_changed" });
          } catch (err) {
            if (taskConversation) {
              (taskConversation as { headlessLock: boolean }).headlessLock =
                false;
            }
            log.error({ err, workItemId }, "work_item_run_task (HTTP) failed");
            updateWorkItem(workItemId, {
              status: "failed",
              lastRunStatus: "failed",
            });
            broadcastWorkItemStatus(workItemId);
            publishEvent({ type: "tasks_changed" });
          }
        })();

        return Response.json({
          id: params.id,
          success: true,
          lastRunId: "",
        });
      },
    },
  ];
}
