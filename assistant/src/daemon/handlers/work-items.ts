import * as net from "node:net";

import {
  approveWorkItemPermissions,
  getWorkItemOutput,
  preflightWorkItem,
} from "../../runtime/routes/work-items-routes.js";
import { getSubagentManager } from "../../subagent/index.js";
import { runTask } from "../../tasks/task-runner.js";
import { getTask } from "../../tasks/task-store.js";
import {
  getRegisteredToolNames,
  sanitizeToolList,
} from "../../tasks/tool-sanitizer.js";
import {
  deleteWorkItem,
  getWorkItem,
  listWorkItems,
  updateWorkItem,
  type WorkItemStatus,
} from "../../work-items/work-item-store.js";
import type {
  WorkItemApprovePermissionsRequest,
  WorkItemCancelRequest,
  WorkItemCompleteRequest,
  WorkItemDeleteRequest,
  WorkItemGetRequest,
  WorkItemOutputRequest,
  WorkItemPreflightRequest,
  WorkItemRunTaskRequest,
  WorkItemsListRequest,
  WorkItemUpdateRequest,
} from "../ipc-protocol.js";
import { defineHandlers, type HandlerContext, log } from "./shared.js";

export function handleWorkItemsList(
  msg: WorkItemsListRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const items = listWorkItems(
    msg.status ? { status: msg.status as WorkItemStatus } : undefined,
  );
  ctx.send(socket, { type: "work_items_list_response", items });
}

export function handleWorkItemGet(
  msg: WorkItemGetRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const item = getWorkItem(msg.id) ?? null;
  ctx.send(socket, { type: "work_item_get_response", item });
}

export function handleWorkItemUpdate(
  msg: WorkItemUpdateRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  // Don't allow overwriting a cancelled status (e.g. from a late chat-completion observer)
  if (msg.status !== undefined) {
    const existing = getWorkItem(msg.id);
    if (existing?.status === "cancelled" && msg.status !== "cancelled") {
      ctx.send(socket, { type: "work_item_update_response", item: existing });
      return;
    }
  }

  const updates: Record<string, unknown> = {};
  if (msg.title !== undefined) updates.title = msg.title;
  if (msg.notes !== undefined) updates.notes = msg.notes;
  if (msg.status !== undefined) updates.status = msg.status;
  if (msg.priorityTier !== undefined) updates.priorityTier = msg.priorityTier;
  if (msg.sortIndex !== undefined) updates.sortIndex = msg.sortIndex;

  const item =
    updateWorkItem(msg.id, updates as Parameters<typeof updateWorkItem>[1]) ??
    null;
  ctx.send(socket, { type: "work_item_update_response", item });

  // Broadcast to all clients so other open task views stay in sync
  // (e.g. priority/sort changes made by one client are reflected everywhere)
  if (item) {
    broadcastWorkItemStatus(ctx, item.id);
    ctx.broadcast({ type: "tasks_changed" });
  }
}

export function handleWorkItemComplete(
  msg: WorkItemCompleteRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  // Only allow completion from the 'awaiting_review' state — this ensures
  // items go through the full run lifecycle before being marked done.
  const existing = getWorkItem(msg.id);
  if (!existing) {
    ctx.send(socket, {
      type: "error",
      message: `Work item not found: ${msg.id}`,
    });
    return;
  }
  if (existing.status !== "awaiting_review") {
    ctx.send(socket, {
      type: "error",
      message: `Cannot complete work item: status is '${existing.status}', expected 'awaiting_review'`,
    });
    return;
  }

  const item = updateWorkItem(msg.id, { status: "done" }) ?? null;
  ctx.send(socket, { type: "work_item_update_response", item });
  if (item) {
    ctx.broadcast({
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
    ctx.broadcast({ type: "tasks_changed" });
  }
}

export function handleWorkItemDelete(
  msg: WorkItemDeleteRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const existing = getWorkItem(msg.id);
  if (!existing) {
    ctx.send(socket, {
      type: "work_item_delete_response",
      id: msg.id,
      success: false,
    });
    return;
  }
  deleteWorkItem(msg.id);
  ctx.send(socket, {
    type: "work_item_delete_response",
    id: msg.id,
    success: true,
  });
  ctx.broadcast({ type: "tasks_changed" });
}

function broadcastWorkItemStatus(ctx: HandlerContext, id: string): void {
  const item = getWorkItem(id);
  if (item) {
    ctx.broadcast({
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

export function handleWorkItemOutput(
  msg: WorkItemOutputRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    const result = getWorkItemOutput(msg.id);
    ctx.send(socket, {
      type: "work_item_output_response",
      id: msg.id,
      ...result,
    });
  } catch (err) {
    log.error({ err, workItemId: msg.id }, "handleWorkItemOutput failed");
    ctx.send(socket, {
      type: "work_item_output_response",
      id: msg.id,
      success: false,
      error: "Failed to load task output",
    });
  }
}

export async function handleWorkItemRunTask(
  msg: WorkItemRunTaskRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  const workItem = getWorkItem(msg.id);
  if (!workItem) {
    ctx.send(socket, {
      type: "work_item_run_task_response",
      id: msg.id,
      lastRunId: "",
      success: false,
      error: "Work item not found",
      errorCode: "not_found",
    });
    return;
  }

  if (workItem.status === "running") {
    ctx.send(socket, {
      type: "work_item_run_task_response",
      id: msg.id,
      lastRunId: workItem.lastRunId ?? "",
      success: false,
      error: "Work item is already running",
      errorCode: "already_running",
    });
    return;
  }

  const NON_RUNNABLE_STATUSES: readonly string[] = ["archived"];
  if (NON_RUNNABLE_STATUSES.includes(workItem.status)) {
    ctx.send(socket, {
      type: "work_item_run_task_response",
      id: msg.id,
      lastRunId: workItem.lastRunId ?? "",
      success: false,
      error: `Work item has status '${workItem.status}' and cannot be run`,
      errorCode: "invalid_status",
    });
    return;
  }

  const task = getTask(workItem.taskId);
  if (!task) {
    ctx.send(socket, {
      type: "work_item_run_task_response",
      id: msg.id,
      lastRunId: "",
      success: false,
      error: `Associated task not found: ${workItem.taskId}`,
      errorCode: "no_task",
    });
    return;
  }

  // Compute required tools using the same resolution logic as preflight:
  // work-item snapshot first, then task template, then all registered tools.
  let requiredTools: string[];
  if (workItem.requiredTools != null) {
    requiredTools = sanitizeToolList(JSON.parse(workItem.requiredTools));
  } else {
    requiredTools = task.requiredTools
      ? sanitizeToolList(JSON.parse(task.requiredTools))
      : getRegisteredToolNames();
  }

  // Permission checkpoint: if the task requires tools, verify all have been approved.
  // Empty required tools means no approvals needed.
  let approvedTools: string[] | undefined;
  if (requiredTools.length > 0) {
    approvedTools = workItem.approvedTools
      ? JSON.parse(workItem.approvedTools)
      : undefined;
    const approvedSet = new Set<string>(approvedTools ?? []);
    const missingApprovals = requiredTools.filter((t) => !approvedSet.has(t));
    if (missingApprovals.length > 0) {
      ctx.send(socket, {
        type: "work_item_run_task_response",
        id: msg.id,
        lastRunId: "",
        success: false,
        error:
          "Required tool permissions have not been approved. Run preflight first.",
        errorCode: "permission_required",
      });
      return;
    }
  }

  // Set status to running
  updateWorkItem(msg.id, { status: "running" });

  // Return immediately with acknowledgment
  ctx.send(socket, {
    type: "work_item_run_task_response",
    id: msg.id,
    lastRunId: "",
    success: true,
  });

  // Broadcast the running state
  broadcastWorkItemStatus(ctx, msg.id);
  ctx.broadcast({ type: "tasks_changed" });

  // Execute task asynchronously — lazily create a session inside the callback
  // using the conversationId provided by runTask, so the session references
  // the conversation that was actually inserted into the database.
  let session: Awaited<ReturnType<typeof ctx.getOrCreateSession>> | null = null;
  try {
    const result = await runTask(
      { taskId: workItem.taskId, workingDir: process.cwd(), approvedTools },
      async (conversationId, message, taskRunId) => {
        if (!session) {
          // Store conversationId on the work item immediately so the cancel
          // handler can locate the session while the task is still running.
          updateWorkItem(msg.id, { lastRunConversationId: conversationId });
          session = await ctx.getOrCreateSession(conversationId);

          // Notify clients so they can create a visible chat thread for this task run
          ctx.broadcast({
            type: "task_run_thread_created",
            conversationId,
            workItemId: msg.id,
            title: workItem.title,
          });
          // Wire the taskRunId so the executor can retrieve ephemeral permission rules
          session.taskRunId = taskRunId;
          // Prevent interactive clients from rebinding to this session mid-run
          session.headlessLock = true;
        }
        await session.processMessage(
          message,
          [],
          (event) => {
            ctx.broadcast(event);
          },
          undefined,
          undefined,
          undefined,
          { isInteractive: false },
        );
      },
    );

    // Release the headless lock now that the task run is done
    // (TS can't track that session is mutated inside the closure above)
    const doneSession = session as { headlessLock: boolean } | null;
    if (doneSession) {
      doneSession.headlessLock = false;
    }

    // Don't overwrite cancelled status — the cancel handler already set it
    const current = getWorkItem(msg.id);
    if (current?.status !== "cancelled") {
      const finalStatus: WorkItemStatus =
        result.status === "completed" ? "awaiting_review" : "failed";
      updateWorkItem(msg.id, {
        status: finalStatus,
        lastRunId: result.taskRunId,
        lastRunConversationId: result.conversationId,
        lastRunStatus: result.status,
      });
    }

    broadcastWorkItemStatus(ctx, msg.id);
    ctx.broadcast({ type: "tasks_changed" });
  } catch (err) {
    // Release the headless lock on failure
    const errSession = session as { headlessLock: boolean } | null;
    if (errSession) {
      errSession.headlessLock = false;
    }
    log.error({ err, workItemId: msg.id }, "work_item_run_task failed");
    updateWorkItem(msg.id, {
      status: "failed",
      lastRunStatus: "failed",
    });
    broadcastWorkItemStatus(ctx, msg.id);
    ctx.broadcast({ type: "tasks_changed" });
  }
}

export async function handleWorkItemPreflight(
  msg: WorkItemPreflightRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  const result = await preflightWorkItem(msg.id);
  ctx.send(socket, {
    type: "work_item_preflight_response",
    id: msg.id,
    ...result,
  });
}

export function handleWorkItemApprovePermissions(
  msg: WorkItemApprovePermissionsRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const result = approveWorkItemPermissions(msg.id, msg.approvedTools);
  ctx.send(socket, {
    type: "work_item_approve_permissions_response",
    id: msg.id,
    ...result,
  });
}

export function handleWorkItemCancel(
  msg: WorkItemCancelRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const workItem = getWorkItem(msg.id);
  if (!workItem) {
    ctx.send(socket, {
      type: "work_item_cancel_response",
      id: msg.id,
      success: false,
      error: "Work item not found",
    });
    return;
  }

  if (workItem.status !== "running") {
    ctx.send(socket, {
      type: "work_item_cancel_response",
      id: msg.id,
      success: false,
      error: `Work item is not running (status: ${workItem.status})`,
    });
    return;
  }

  // Abort the session associated with this work item's current run
  const conversationId = workItem.lastRunConversationId;
  if (conversationId) {
    const session = ctx.sessions.get(conversationId);
    if (session) {
      session.headlessLock = false;
      session.abort();
      getSubagentManager().abortAllForParent(conversationId);
    }
  }

  updateWorkItem(msg.id, {
    status: "cancelled",
    lastRunStatus: "cancelled",
  });

  ctx.send(socket, {
    type: "work_item_cancel_response",
    id: msg.id,
    success: true,
  });

  broadcastWorkItemStatus(ctx, msg.id);
  ctx.broadcast({ type: "tasks_changed" });
}

export const workItemHandlers = defineHandlers({
  work_items_list: handleWorkItemsList,
  work_item_get: handleWorkItemGet,
  work_item_update: handleWorkItemUpdate,
  work_item_complete: handleWorkItemComplete,
  work_item_delete: handleWorkItemDelete,
  work_item_run_task: handleWorkItemRunTask,
  work_item_output: handleWorkItemOutput,
  work_item_preflight: handleWorkItemPreflight,
  work_item_approve_permissions: handleWorkItemApprovePermissions,
  work_item_cancel: handleWorkItemCancel,
});
