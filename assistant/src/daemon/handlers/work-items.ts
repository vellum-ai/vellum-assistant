import * as net from 'node:net';
import type {
  WorkItemsListRequest,
  WorkItemGetRequest,
  WorkItemUpdateRequest,
  WorkItemCompleteRequest,
  WorkItemDeleteRequest,
  WorkItemRunTaskRequest,
  WorkItemOutputRequest,
  WorkItemPreflightRequest,
  WorkItemApprovePermissionsRequest,
  WorkItemCancelRequest,
} from '../ipc-protocol.js';
import { log, defineHandlers, type HandlerContext } from './shared.js';
import { getSubagentManager } from '../../subagent/index.js';
import {
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
import { truncate } from '../../util/truncate.js';
import { CANONICAL_TOOLS, sanitizeToolList, getToolDescription } from '../../tasks/tool-sanitizer.js';

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

export function handleWorkItemUpdate(
  msg: WorkItemUpdateRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  // Don't allow overwriting a cancelled status (e.g. from a late chat-completion observer)
  if (msg.status !== undefined) {
    const existing = getWorkItem(msg.id);
    if (existing?.status === 'cancelled' && msg.status !== 'cancelled') {
      ctx.send(socket, { type: 'work_item_update_response', item: existing });
      return;
    }
  }

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

/** Extract plain text from a message content string (handles JSON content block arrays). */
function extractTextFromContent(content: string): string {
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((b: { type: string }) => b.type === 'text')
        .map((b: { text: string }) => b.text)
        .join('\n');
    }
  } catch {
    // Plain text content — use as-is
  }
  return content;
}

/** Extract tool_result blocks from a user message's content. */
function extractToolResults(content: string): Array<{ tool_use_id: string; content: string; is_error?: boolean }> {
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((b: { type: string }) => b.type === 'tool_result')
        .map((b: { tool_use_id: string; content?: string | Array<{ type: string; text?: string }>; is_error?: boolean }) => {
          let text = '';
          if (typeof b.content === 'string') {
            text = b.content;
          } else if (Array.isArray(b.content)) {
            text = b.content
              .filter((c) => c.type === 'text' && c.text)
              .map((c) => c.text!)
              .join('\n');
          }
          return { tool_use_id: b.tool_use_id, content: text, is_error: b.is_error };
        });
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
    if (m.role !== 'assistant') continue;
    try {
      const parsed = JSON.parse(m.content);
      if (Array.isArray(parsed)) {
        for (const block of parsed) {
          if (block.type === 'tool_use' && block.id && block.name) {
            toolNameById.set(block.id, block.name);
          }
        }
      }
    } catch { /* skip */ }
  }

  // Scan tool_result messages in reverse order (most recent first)
  for (let i = msgs.length - 1; i >= 0 && highlights.length < maxHighlights; i--) {
    const m = msgs[i];
    if (m.role !== 'user') continue;

    const results = extractToolResults(m.content);
    for (const result of results) {
      if (highlights.length >= maxHighlights) break;

      const toolName = toolNameById.get(result.tool_use_id) ?? 'tool';
      const resultText = result.content.trim();

      if (result.is_error) {
        // Always surface errors
        const errorSnippet = truncate(resultText, 200, '...');
        highlights.push(`- ${toolName}: Error — ${errorSnippet}`);
      } else if (resultText) {
        // Extract notable signal from successful results: file paths, URLs, or
        // a short summary of what happened
        const firstLine = resultText.split('\n')[0].trim();
        if (firstLine.length > 0 && firstLine.length <= 200) {
          highlights.push(`- ${toolName}: ${firstLine}`);
        } else if (firstLine.length > 200) {
          highlights.push(`- ${toolName}: ${truncate(firstLine, 200, '...')}`);
        }
      }
    }
  }

  return highlights;
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

    // Use the task run's conversationId as the authoritative source. This
    // ensures we read from the actual run's conversation, not stale references
    // on the work item.
    let conversationId: string | null = null;
    let completedAt: number | null = null;

    if (workItem.lastRunId) {
      const run = getTaskRun(workItem.lastRunId);
      if (run) {
        conversationId = run.conversationId;
        completedAt = run.finishedAt != null ? Math.floor(run.finishedAt / 1000) : null;
      }
    }

    // Fall back to the work item's stored conversationId if the run lookup
    // didn't yield one (e.g. run record was deleted but work item still has
    // the reference).
    if (!conversationId) {
      conversationId = workItem.lastRunConversationId;
    }

    if (!conversationId) {
      ctx.send(socket, { type: 'work_item_output_response', id: msg.id, success: false, error: 'This task has not been run yet. No output is available.' });
      return;
    }

    let summary = '';
    let highlights: string[] = [];

    const msgs = getMessages(conversationId);

    // Find the last assistant message with text content (not tool calls).
    // Skip messages that are purely about task management rather than
    // reporting what the run actually did.
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role !== 'assistant') continue;

      const text = extractTextFromContent(m.content);
      if (!text.trim()) continue;

      summary = truncate(text, 2000, '');

      // Extract bullet points from the assistant's prose
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

    // If we didn't get enough highlights from the assistant prose, supplement
    // with concrete tool outcomes from the conversation.
    if (highlights.length < 5) {
      const toolHighlights = extractToolHighlights(msgs, 5 - highlights.length);
      highlights = [...highlights, ...toolHighlights];
    }

    // If there's no assistant summary at all, synthesize one from tool results
    // so the user still sees what happened.
    if (!summary && msgs.length > 0) {
      const toolHighlights = extractToolHighlights(msgs, 10);
      if (toolHighlights.length > 0) {
        summary = 'Task completed. Tool outcomes:\n' + toolHighlights.join('\n');
        // Use the tool highlights as the main highlights too
        highlights = toolHighlights.slice(0, 5);
      }
    }

    ctx.send(socket, {
      type: 'work_item_output_response',
      id: msg.id,
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

  // Compute required tools using the same resolution logic as preflight:
  // work-item snapshot first, then task template, then CANONICAL_TOOLS fallback.
  let requiredTools: string[];
  if (workItem.requiredTools !== null && workItem.requiredTools !== undefined) {
    requiredTools = sanitizeToolList(JSON.parse(workItem.requiredTools));
  } else {
    requiredTools = task.requiredTools
      ? sanitizeToolList(JSON.parse(task.requiredTools))
      : Object.keys(CANONICAL_TOOLS);
  }

  // Permission checkpoint: if the task requires tools, verify all have been approved.
  // Empty required tools means no approvals needed.
  let approvedTools: string[] | undefined;
  if (requiredTools.length > 0) {
    approvedTools = workItem.approvedTools ? JSON.parse(workItem.approvedTools) : undefined;
    const approvedSet = new Set<string>(approvedTools ?? []);
    const missingApprovals = requiredTools.filter((t) => !approvedSet.has(t));
    if (missingApprovals.length > 0) {
      ctx.send(socket, {
        type: 'work_item_run_task_response',
        id: msg.id,
        lastRunId: '',
        success: false,
        error: 'Required tool permissions have not been approved. Run preflight first.',
        errorCode: 'permission_required',
      });
      return;
    }
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
            type: 'task_run_thread_created',
            conversationId,
            workItemId: msg.id,
            title: workItem.title,
          });
          // Wire the taskRunId so the executor can retrieve ephemeral permission rules
          (session as unknown as { taskRunId?: string }).taskRunId = taskRunId;
          // Prevent interactive clients from rebinding to this session mid-run
          (session as unknown as { headlessLock: boolean }).headlessLock = true;
        }
        await session.processMessage(message, [], (event) => {
          ctx.broadcast(event);
        });
      },
    );

    // Release the headless lock now that the task run is done
    if (session) {
      (session as unknown as { headlessLock: boolean }).headlessLock = false;
    }

    // Don't overwrite cancelled status — the cancel handler already set it
    const current = getWorkItem(msg.id);
    if (current?.status !== 'cancelled') {
      const finalStatus: WorkItemStatus = result.status === 'completed' ? 'awaiting_review' : 'failed';
      updateWorkItem(msg.id, {
        status: finalStatus,
        lastRunId: result.taskRunId,
        lastRunConversationId: result.conversationId,
        lastRunStatus: result.status,
      });
    }

    broadcastWorkItemStatus(ctx, msg.id);
    ctx.broadcast({ type: 'tasks_changed' });
  } catch (err) {
    // Release the headless lock on failure
    if (session) {
      (session as unknown as { headlessLock: boolean }).headlessLock = false;
    }
    log.error({ err, workItemId: msg.id }, 'work_item_run_task failed');
    updateWorkItem(msg.id, {
      status: 'failed',
      lastRunStatus: 'failed',
    });
    broadcastWorkItemStatus(ctx, msg.id);
    ctx.broadcast({ type: 'tasks_changed' });
  }
}


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

  // Compute required tools from the work-item snapshot first; only fall
  // back to the task template (or CANONICAL_TOOLS default) when the
  // snapshot is null.
  let requiredTools: string[];
  if (workItem.requiredTools !== null && workItem.requiredTools !== undefined) {
    requiredTools = sanitizeToolList(JSON.parse(workItem.requiredTools));
  } else {
    const task = getTask(workItem.taskId);
    if (!task) {
      ctx.send(socket, { type: 'work_item_preflight_response', id: msg.id, success: false, error: `Associated task not found: ${workItem.taskId}` });
      return;
    }
    requiredTools = task.requiredTools
      ? sanitizeToolList(JSON.parse(task.requiredTools))
      : Object.keys(CANONICAL_TOOLS);
  }

  // If the work item explicitly requires no tools, skip the dialog.
  if (requiredTools.length === 0) {
    ctx.send(socket, { type: 'work_item_preflight_response', id: msg.id, success: true, permissions: [] });
    return;
  }

  // If some tools are already approved, only prompt for the missing ones.
  // When all required tools are covered, skip the dialog entirely.
  if (workItem.approvedTools) {
    const approvedSet = new Set<string>(JSON.parse(workItem.approvedTools));
    requiredTools = requiredTools.filter((t) => !approvedSet.has(t));
    if (requiredTools.length === 0) {
      ctx.send(socket, { type: 'work_item_preflight_response', id: msg.id, success: true, permissions: [] });
      return;
    }
  }

  const workingDir = process.cwd();
  const permissions = await Promise.all(
    requiredTools.map(async (tool) => {
      const risk = await classifyRisk(tool, {}, workingDir);
      const result = await check(tool, {}, workingDir);
      return {
        tool,
        description: getToolDescription(tool),
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

  // Merge newly approved tools with any previously approved ones so reruns
  // that only need a subset of previously-approved tools don't require
  // re-approval.
  const existingApproved: string[] = workItem.approvedTools
    ? JSON.parse(workItem.approvedTools)
    : [];
  const newApproved = sanitizeToolList(msg.approvedTools);
  const merged = [...new Set([...existingApproved, ...newApproved])];

  updateWorkItem(msg.id, {
    approvedTools: JSON.stringify(sanitizeToolList(merged)),
    approvalStatus: 'approved',
  });

  ctx.send(socket, { type: 'work_item_approve_permissions_response', id: msg.id, success: true });
}

export function handleWorkItemCancel(
  msg: WorkItemCancelRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const workItem = getWorkItem(msg.id);
  if (!workItem) {
    ctx.send(socket, { type: 'work_item_cancel_response', id: msg.id, success: false, error: 'Work item not found' });
    return;
  }

  if (workItem.status !== 'running') {
    ctx.send(socket, { type: 'work_item_cancel_response', id: msg.id, success: false, error: `Work item is not running (status: ${workItem.status})` });
    return;
  }

  // Abort the session associated with this work item's current run
  const conversationId = workItem.lastRunConversationId;
  if (conversationId) {
    const session = ctx.sessions.get(conversationId);
    if (session) {
      (session as unknown as { headlessLock: boolean }).headlessLock = false;
      session.abort();
      getSubagentManager().abortAllForParent(conversationId);
    }
  }

  updateWorkItem(msg.id, {
    status: 'cancelled',
    lastRunStatus: 'cancelled',
  });

  ctx.send(socket, { type: 'work_item_cancel_response', id: msg.id, success: true });

  broadcastWorkItemStatus(ctx, msg.id);
  ctx.broadcast({ type: 'tasks_changed' });
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
