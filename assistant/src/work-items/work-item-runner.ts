/**
 * Module-level registry for running work items from tool context.
 *
 * The daemon server registers its `getOrCreateSession` and `broadcast`
 * callbacks at startup. Tool implementations can then trigger async
 * work item execution without needing direct access to HandlerContext.
 */

import { getLogger } from '../util/logger.js';
import { getWorkItem, updateWorkItem, type WorkItemStatus } from './work-item-store.js';
import { getTask } from '../tasks/task-store.js';
import { runTask } from '../tasks/task-runner.js';
import { sanitizeToolList, getRegisteredToolNames } from '../tasks/tool-sanitizer.js';
import type { Session } from '../daemon/session.js';
import type { ServerMessage } from '../daemon/ipc-protocol.js';

const log = getLogger('work-item-runner');

// ── Daemon callback registry ─────────────────────────────────────────

interface DaemonCallbacks {
  getOrCreateSession: (conversationId: string) => Promise<Session>;
  broadcast: (msg: ServerMessage) => void;
}

let _callbacks: DaemonCallbacks | null = null;

export function registerDaemonCallbacks(callbacks: DaemonCallbacks): void {
  _callbacks = callbacks;
}

// ── Public API ───────────────────────────────────────────────────────

function broadcastWorkItemStatus(broadcast: (msg: ServerMessage) => void, id: string): void {
  const item = getWorkItem(id);
  if (item) {
    broadcast({
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
    } as ServerMessage);
  }
}

export interface RunWorkItemResult {
  success: boolean;
  error?: string;
  errorCode?: string;
}

/**
 * Run a work item in the background. Returns immediately after validation.
 * The actual execution happens asynchronously.
 *
 * When called from a chat tool (e.g. Telegram), required tools are
 * auto-approved since the user explicitly requested execution.
 */
export function runWorkItemInBackground(workItemId: string): RunWorkItemResult {
  if (!_callbacks) {
    return { success: false, error: 'Daemon callbacks not registered', errorCode: 'not_initialized' };
  }

  const workItem = getWorkItem(workItemId);
  if (!workItem) {
    return { success: false, error: 'Work item not found', errorCode: 'not_found' };
  }

  if (workItem.status === 'running') {
    return { success: false, error: 'Work item is already running', errorCode: 'already_running' };
  }

  const NON_RUNNABLE_STATUSES: readonly string[] = ['archived'];
  if (NON_RUNNABLE_STATUSES.includes(workItem.status)) {
    return { success: false, error: `Work item has status '${workItem.status}' and cannot be run`, errorCode: 'invalid_status' };
  }

  const task = getTask(workItem.taskId);
  if (!task) {
    return { success: false, error: `Associated task not found: ${workItem.taskId}`, errorCode: 'no_task' };
  }

  // Resolve required tools
  let requiredTools: string[];
  if (workItem.requiredTools !== null && workItem.requiredTools !== undefined) {
    requiredTools = sanitizeToolList(JSON.parse(workItem.requiredTools));
  } else {
    requiredTools = task.requiredTools
      ? sanitizeToolList(JSON.parse(task.requiredTools))
      : getRegisteredToolNames();
  }

  // Auto-approve all required tools for chat-initiated runs.
  // The user explicitly asked to run the task, so we treat that as consent.
  const approvedTools = requiredTools;

  // Set status to running
  updateWorkItem(workItemId, { status: 'running' });

  const { getOrCreateSession, broadcast } = _callbacks;

  // Broadcast the running state
  broadcastWorkItemStatus(broadcast, workItemId);
  broadcast({ type: 'tasks_changed' } as ServerMessage);

  // Execute asynchronously
  let session: Awaited<ReturnType<typeof getOrCreateSession>> | null = null;
  void (async () => {
    try {
      const result = await runTask(
        { taskId: workItem.taskId, workingDir: process.cwd(), approvedTools },
        async (conversationId, message, taskRunId) => {
          if (!session) {
            updateWorkItem(workItemId, { lastRunConversationId: conversationId });
            session = await getOrCreateSession(conversationId);

            broadcast({
              type: 'task_run_thread_created',
              conversationId,
              workItemId,
              title: workItem.title,
            } as ServerMessage);
            (session as unknown as { taskRunId?: string }).taskRunId = taskRunId;
            (session as unknown as { headlessLock: boolean }).headlessLock = true;
          }
          await session.processMessage(message, [], (event) => {
            broadcast(event);
          });
        },
      );

      if (session) {
        (session as unknown as { headlessLock: boolean }).headlessLock = false;
      }

      const current = getWorkItem(workItemId);
      if (current?.status !== 'cancelled') {
        const finalStatus: WorkItemStatus = result.status === 'completed' ? 'awaiting_review' : 'failed';
        updateWorkItem(workItemId, {
          status: finalStatus,
          lastRunId: result.taskRunId,
          lastRunConversationId: result.conversationId,
          lastRunStatus: result.status,
        });
      }

      broadcastWorkItemStatus(broadcast, workItemId);
      broadcast({ type: 'tasks_changed' } as ServerMessage);
    } catch (err) {
      if (session) {
        (session as unknown as { headlessLock: boolean }).headlessLock = false;
      }
      log.error({ err, workItemId }, 'work item background run failed');
      updateWorkItem(workItemId, {
        status: 'failed',
        lastRunStatus: 'failed',
      });
      broadcastWorkItemStatus(broadcast, workItemId);
      broadcast({ type: 'tasks_changed' } as ServerMessage);
    }
  })();

  return { success: true };
}
