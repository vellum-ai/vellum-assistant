import * as net from 'node:net';
import type {
  WorkItemsListRequest,
  WorkItemGetRequest,
  WorkItemCreateRequest,
  WorkItemUpdateRequest,
  WorkItemCompleteRequest,
  WorkItemDeleteRequest,
  WorkItemRunTaskRequest,
  WorkItemOutputRequest,
  WorkItemPreflightRequest,
  WorkItemApprovePermissionsRequest,
} from '../ipc-protocol.js';
import { log, type HandlerContext } from './shared.js';
import {
  createWorkItem,
  deleteWorkItem,
  getWorkItem,
  listWorkItems,
  updateWorkItem,
  type WorkItemStatus,
} from '../../work-items/work-item-store.js';
import { getTask, getTaskRun } from '../../tasks/task-store.js';
import { runTask } from '../../tasks/task-runner.js';
import { getMessages } from '../../memory/conversation-store.js';
import { classifyRisk, check } from '../../permissions/checker.js';

export function handleWorkItemsList(
  msg: WorkItemsListRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const items = listWorkItems(msg.status ? { status: msg.status as WorkItemStatus } : undefined);
  ctx.send(socket, { type: 'work_items_list_response', items });
}

export function handleWorkItemGet(
  msg: WorkItemGetRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const item = getWorkItem(msg.id) ?? null;
  ctx.send(socket, { type: 'work_item_get_response', item });
}

export function handleWorkItemCreate(
  msg: WorkItemCreateRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const task = getTask(msg.taskId);
  if (!task) {
    ctx.send(socket, { type: 'error', message: `Task not found: ${msg.taskId}` });
    return;
  }
  const item = createWorkItem({
    taskId: msg.taskId,
    title: msg.title ?? task.title,
    notes: msg.notes,
    priorityTier: msg.priorityTier,
    sortIndex: msg.sortIndex,
  });
  ctx.send(socket, { type: 'work_item_create_response', item });

  // Notify all connected clients so open Task Queue views refresh immediately
  broadcastWorkItemStatus(ctx, item.id);
  ctx.broadcast({ type: 'tasks_changed' });
}

export function handleWorkItemUpdate(
  msg: WorkItemUpdateRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const updates: Record<string, unknown> = {};
  if (msg.title !== undefined) updates.title = msg.title;
  if (msg.notes !== undefined) updates.notes = msg.notes;
  if (msg.status !== undefined) updates.status = msg.status;
  if (msg.priorityTier !== undefined) updates.priorityTier = msg.priorityTier;
  if (msg.sortIndex !== undefined) updates.sortIndex = msg.sortIndex;

  const item = updateWorkItem(msg.id, updates as Parameters<typeof updateWorkItem>[1]) ?? null;
  ctx.send(socket, { type: 'work_item_update_response', item });

  // Broadcast to all clients so other open task views stay in sync
  // (e.g. priority/sort changes made by one client are reflected everywhere)
  if (item) {
    broadcastWorkItemStatus(ctx, item.id);
    ctx.broadcast({ type: 'tasks_changed' });
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
    ctx.send(socket, { type: 'error', message: `Work item not found: ${msg.id}` });
    return;
  }
  if (existing.status !== 'awaiting_review') {
    ctx.send(socket, { type: 'error', message: `Cannot complete work item: status is '${existing.status}', expected 'awaiting_review'` });
    return;
  }

  const item = updateWorkItem(msg.id, { status: 'done' }) ?? null;
  ctx.send(socket, { type: 'work_item_update_response', item });
  if (item) {
    ctx.broadcast({
      type: 'work_item_status_changed',
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
    ctx.broadcast({ type: 'tasks_changed' });
  }
}

export function handleWorkItemDelete(
  msg: WorkItemDeleteRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const existing = getWorkItem(msg.id);
  if (!existing) {
    ctx.send(socket, { type: 'work_item_delete_response', id: msg.id, success: false });
    return;
  }
  deleteWorkItem(msg.id);
  ctx.send(socket, { type: 'work_item_delete_response', id: msg.id, success: true });
  ctx.broadcast({ type: 'tasks_changed' });
}

function broadcastWorkItemStatus(ctx: HandlerContext, id: string): void {
  const item = getWorkItem(id);
  if (item) {
    ctx.broadcast({
      type: 'work_item_status_changed',
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
    const workItem = getWorkItem(msg.id);
    if (!workItem) {
      ctx.send(socket, { type: 'work_item_output_response', id: msg.id, success: false, error: 'Work item not found' });
      return;
    }

    // If the work item has never been run, return an error so the client
    // can show "No output yet" instead of an empty loaded state.
    if (!workItem.lastRunConversationId) {
      ctx.send(socket, { type: 'work_item_output_response', id: msg.id, success: false, error: 'This task has not been run yet. No output is available.' });
      return;
    }

    let summary = '';
    const highlights: string[] = [];

    const msgs = getMessages(workItem.lastRunConversationId);
    // Find the last assistant message with text content (not tool calls)
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role !== 'assistant') continue;

      let text = m.content;
      // Content may be JSON array of content blocks — extract text blocks only
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          text = parsed
            .filter((b: { type: string }) => b.type === 'text')
            .map((b: { text: string }) => b.text)
            .join('\n');
        }
      } catch {
        // Plain text content — use as-is
      }

      if (!text.trim()) continue;

      summary = text.length > 2000 ? text.slice(0, 2000) : text;

      // Extract up to 5 notable lines (bullet points or key findings)
      const lines = text.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if ((trimmed.startsWith('-') || trimmed.startsWith('*')) && trimmed.length > 2) {
          highlights.push(trimmed);
          if (highlights.length >= 5) break;
        }
      }
      break;
    }

    // Convert finishedAt from milliseconds (Date.now()) to seconds for the
    // client, which uses Date(timeIntervalSince1970:) expecting seconds.
    let completedAt: number | null = null;
    if (workItem.lastRunId) {
      const run = getTaskRun(workItem.lastRunId);
      completedAt = run?.finishedAt != null ? Math.floor(run.finishedAt / 1000) : null;
    }

    ctx.send(socket, {
      type: 'work_item_output_response',
      id: msg.id,
      success: true,
      output: {
        title: workItem.title,
        status: workItem.lastRunStatus ?? workItem.status,
        runId: workItem.lastRunId,
        conversationId: workItem.lastRunConversationId,
        completedAt,
        summary,
        highlights,
      },
    });
  } catch (err) {
    log.error({ err, workItemId: msg.id }, 'handleWorkItemOutput failed');
    ctx.send(socket, { type: 'work_item_output_response', id: msg.id, success: false, error: 'Failed to load task output' });
  }
}

export async function handleWorkItemRunTask(
  msg: WorkItemRunTaskRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  const workItem = getWorkItem(msg.id);
  if (!workItem) {
    ctx.send(socket, { type: 'work_item_run_task_response', id: msg.id, lastRunId: '', success: false, error: 'Work item not found', errorCode: 'not_found' });
    return;
  }

  if (workItem.status === 'running') {
    ctx.send(socket, { type: 'work_item_run_task_response', id: msg.id, lastRunId: workItem.lastRunId ?? '', success: false, error: 'Work item is already running', errorCode: 'already_running' });
    return;
  }

  const NON_RUNNABLE_STATUSES: readonly string[] = ['archived'];
  if (NON_RUNNABLE_STATUSES.includes(workItem.status)) {
    ctx.send(socket, { type: 'work_item_run_task_response', id: msg.id, lastRunId: workItem.lastRunId ?? '', success: false, error: `Work item has status '${workItem.status}' and cannot be run`, errorCode: 'invalid_status' });
    return;
  }

  const task = getTask(workItem.taskId);
  if (!task) {
    ctx.send(socket, { type: 'work_item_run_task_response', id: msg.id, lastRunId: '', success: false, error: `Associated task not found: ${workItem.taskId}`, errorCode: 'no_task' });
    return;
  }

  // Set status to running
  updateWorkItem(msg.id, { status: 'running' });

  // Return immediately with acknowledgment
  ctx.send(socket, { type: 'work_item_run_task_response', id: msg.id, lastRunId: '', success: true });

  // Broadcast the running state
  broadcastWorkItemStatus(ctx, msg.id);
  ctx.broadcast({ type: 'tasks_changed' });

  // Execute task asynchronously — lazily create a session inside the callback
  // using the conversationId provided by runTask, so the session references
  // the conversation that was actually inserted into the database.
  try {
    let session: Awaited<ReturnType<typeof ctx.getOrCreateSession>> | null = null;
    // Pass pre-approved tools from the preflight flow if available
    const approvedTools: string[] | undefined = workItem.approvedTools ? JSON.parse(workItem.approvedTools) : undefined;
    const result = await runTask(
      { taskId: workItem.taskId, workingDir: process.cwd(), approvedTools },
      async (conversationId, message) => {
        if (!session) {
          session = await ctx.getOrCreateSession(conversationId);
        }
        await session.processMessage(message, [], (event) => {
          ctx.broadcast(event);
        });
      },
    );

    const finalStatus: WorkItemStatus = result.status === 'completed' ? 'done' : 'failed';
    updateWorkItem(msg.id, {
      status: finalStatus,
      lastRunId: result.taskRunId,
      lastRunConversationId: result.conversationId,
      lastRunStatus: result.status,
    });

    broadcastWorkItemStatus(ctx, msg.id);
    ctx.broadcast({ type: 'tasks_changed' });
  } catch (err) {
    log.error({ err, workItemId: msg.id }, 'work_item_run_task failed');
    updateWorkItem(msg.id, {
      status: 'failed',
      lastRunStatus: 'failed',
    });
    broadcastWorkItemStatus(ctx, msg.id);
    ctx.broadcast({ type: 'tasks_changed' });
  }
}

const TOOL_DESCRIPTIONS: Record<string, string> = {
  bash: 'Execute shell commands',
  host_bash: 'Execute shell commands on host',
  file_read: 'Read files',
  file_write: 'Write files',
  file_edit: 'Edit files',
  host_file_read: 'Read host files',
  host_file_write: 'Write host files',
  host_file_edit: 'Edit host files',
  web_fetch: 'Fetch web URLs',
  web_search: 'Search the web',
  browser_navigate: 'Navigate browser',
  network_request: 'Make network requests',
  skill_load: 'Load skills',
};

export async function handleWorkItemPreflight(
  msg: WorkItemPreflightRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  const workItem = getWorkItem(msg.id);
  if (!workItem) {
    ctx.send(socket, { type: 'work_item_preflight_response', id: msg.id, success: false, error: 'Work item not found' });
    return;
  }

  const task = getTask(workItem.taskId);
  if (!task) {
    ctx.send(socket, { type: 'work_item_preflight_response', id: msg.id, success: false, error: `Associated task not found: ${workItem.taskId}` });
    return;
  }

  const requiredTools: string[] = task.requiredTools ? JSON.parse(task.requiredTools) : [];
  if (requiredTools.length === 0) {
    ctx.send(socket, { type: 'work_item_preflight_response', id: msg.id, success: true, permissions: [] });
    return;
  }

  const workingDir = process.cwd();
  const permissions = await Promise.all(
    requiredTools.map(async (tool) => {
      const risk = await classifyRisk(tool, {}, workingDir);
      const result = await check(tool, {}, workingDir);
      return {
        tool,
        description: TOOL_DESCRIPTIONS[tool] ?? tool,
        riskLevel: risk.toLowerCase() as 'low' | 'medium' | 'high',
        currentDecision: result.decision as 'allow' | 'deny' | 'prompt',
      };
    }),
  );

  ctx.send(socket, { type: 'work_item_preflight_response', id: msg.id, success: true, permissions });
}

export function handleWorkItemApprovePermissions(
  msg: WorkItemApprovePermissionsRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const workItem = getWorkItem(msg.id);
  if (!workItem) {
    ctx.send(socket, { type: 'work_item_approve_permissions_response', id: msg.id, success: false, error: 'Work item not found' });
    return;
  }

  updateWorkItem(msg.id, {
    approvedTools: JSON.stringify(msg.approvedTools),
    approvalStatus: 'approved',
  });

  ctx.send(socket, { type: 'work_item_approve_permissions_response', id: msg.id, success: true });
}
