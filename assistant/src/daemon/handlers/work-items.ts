import * as net from 'node:net';
import type {
  WorkItemsListRequest,
  WorkItemGetRequest,
  WorkItemCreateRequest,
  WorkItemUpdateRequest,
  WorkItemCompleteRequest,
  WorkItemRunTaskRequest,
} from '../ipc-protocol.js';
import { log, type HandlerContext } from './shared.js';
import {
  createWorkItem,
  getWorkItem,
  listWorkItems,
  updateWorkItem,
  type WorkItemStatus,
} from '../../work-items/work-item-store.js';
import { getTask } from '../../tasks/task-store.js';
import { runTask } from '../../tasks/task-runner.js';

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
  }
}

export function handleWorkItemComplete(
  msg: WorkItemCompleteRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
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
  }
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

export async function handleWorkItemRunTask(
  msg: WorkItemRunTaskRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  const workItem = getWorkItem(msg.id);
  if (!workItem) {
    ctx.send(socket, { type: 'work_item_run_task_response', id: msg.id, lastRunId: '', success: false, error: 'Work item not found' });
    return;
  }

  // Set status to running
  updateWorkItem(msg.id, { status: 'running' });

  // Return immediately with acknowledgment
  ctx.send(socket, { type: 'work_item_run_task_response', id: msg.id, lastRunId: '', success: true });

  // Broadcast the running state
  broadcastWorkItemStatus(ctx, msg.id);

  // Execute task asynchronously — create a session and wire processMessage
  try {
    const session = await ctx.getOrCreateSession(crypto.randomUUID());
    const result = await runTask(
      { taskId: workItem.taskId, workingDir: process.cwd() },
      async (_conversationId, message) => {
        await session.processMessage(message, [], (event) => {
          ctx.broadcast(event);
        });
      },
    );

    const finalStatus: WorkItemStatus = result.status === 'completed' ? 'awaiting_review' : 'failed';
    updateWorkItem(msg.id, {
      status: finalStatus,
      lastRunId: result.taskRunId,
      lastRunConversationId: result.conversationId,
      lastRunStatus: result.status,
    });

    broadcastWorkItemStatus(ctx, msg.id);
  } catch (err) {
    log.error({ err, workItemId: msg.id }, 'work_item_run_task failed');
    updateWorkItem(msg.id, {
      status: 'failed',
      lastRunStatus: 'failed',
    });
    broadcastWorkItemStatus(ctx, msg.id);
  }
}
