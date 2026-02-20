import { getLogger } from '../util/logger.js';
import { createConversation } from '../memory/conversation-store.js';
import { getTask, createTaskRun, updateTaskRun } from './task-store.js';
import { buildTaskRules, setTaskRunRules, clearTaskRunRules } from './ephemeral-permissions.js';
import { sanitizeToolList } from './tool-sanitizer.js';

const log = getLogger('task-runner');

export interface TaskRunOptions {
  taskId: string;
  inputs?: Record<string, string>;
  workingDir: string;
  /** Pre-approved tools from the permission preflight flow. When set, only these tools get ephemeral allow rules. */
  approvedTools?: string[];
}

export interface TaskRunResult {
  taskRunId: string;
  conversationId: string;
  status: 'completed' | 'failed';
  error?: string;
}

/** Replace {{key}} placeholders in template with values from inputs. */
export function renderTemplate(template: string, inputs: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (key in inputs) return inputs[key];
    return match;
  });
}

/**
 * Execute a task: create a run, set up ephemeral permissions,
 * render the template, and process it as a message.
 */
export async function runTask(
  opts: TaskRunOptions,
  processMessage: (conversationId: string, message: string, taskRunId: string) => Promise<void>,
): Promise<TaskRunResult> {
  const task = getTask(opts.taskId);
  if (!task) {
    throw new Error(`Task not found: ${opts.taskId}`);
  }

  const run = createTaskRun(task.id);
  const conversation = createConversation({ title: `Task: ${task.title}`, threadType: 'background' });

  updateTaskRun(run.id, {
    conversationId: conversation.id,
    memoryScopeId: `task:${task.id}`,
  });

  // Build and register ephemeral permission rules. If the user pre-approved
  // specific tools via the preflight flow, use those instead of all requiredTools.
  const requiredTools = sanitizeToolList(task.requiredTools ? JSON.parse(task.requiredTools) : []);
  const toolsForRules = opts.approvedTools ? sanitizeToolList(opts.approvedTools) : requiredTools;
  const rules = buildTaskRules(run.id, toolsForRules, opts.workingDir);
  setTaskRunRules(run.id, rules);

  try {
    const renderedTemplate = renderTemplate(task.template, opts.inputs ?? {});

    updateTaskRun(run.id, { status: 'running', startedAt: Date.now() });

    log.info({ taskId: task.id, taskRunId: run.id, conversationId: conversation.id }, 'Executing task');
    await processMessage(conversation.id, renderedTemplate, run.id);

    updateTaskRun(run.id, { status: 'completed', finishedAt: Date.now() });

    return {
      taskRunId: run.id,
      conversationId: conversation.id,
      status: 'completed',
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.warn({ err, taskId: task.id, taskRunId: run.id }, 'Task execution failed');

    updateTaskRun(run.id, { status: 'failed', error: errorMessage, finishedAt: Date.now() });

    return {
      taskRunId: run.id,
      conversationId: conversation.id,
      status: 'failed',
      error: errorMessage,
    };
  } finally {
    clearTaskRunRules(run.id);
  }
}
