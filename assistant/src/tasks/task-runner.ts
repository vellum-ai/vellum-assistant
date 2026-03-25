import { bootstrapConversation } from "../memory/conversation-bootstrap.js";
import { invalidateAssistantInferredItemsForConversation } from "../memory/task-memory-cleanup.js";
import { getLogger } from "../util/logger.js";
import {
  buildTaskRules,
  clearTaskRunRules,
  setTaskRunRules,
} from "./ephemeral-permissions.js";
import { createTaskRun, getTask, updateTaskRun } from "./task-store.js";
import { sanitizeToolList } from "./tool-sanitizer.js";

const log = getLogger("task-runner");

export interface TaskRunOptions {
  taskId: string;
  inputs?: Record<string, string>;
  workingDir: string;
  /** Pre-approved tools from the permission preflight flow. When set, only these tools get ephemeral allow rules. */
  approvedTools?: string[];
  /** Conversation source to propagate to the created conversation (e.g. 'schedule' when triggered by a schedule). */
  source?: string;
  /** Schedule job ID to associate with the conversation. Set when the task is triggered by a schedule. */
  scheduleJobId?: string;
}

export interface TaskRunResult {
  taskRunId: string;
  conversationId: string;
  status: "completed" | "failed";
  error?: string;
}

/** Replace {{key}} placeholders in template with values from inputs. */
export function renderTemplate(
  template: string,
  inputs: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (key in inputs) return inputs[key];
    return `<MISSING: ${key}>`;
  });
}

/**
 * Execute a task: create a run, set up ephemeral permissions,
 * render the template, and process it as a message.
 */
export async function runTask(
  opts: TaskRunOptions,
  processMessage: (
    conversationId: string,
    message: string,
    taskRunId: string,
  ) => Promise<void>,
): Promise<TaskRunResult> {
  const task = getTask(opts.taskId);
  if (!task) {
    throw new Error(`Task not found: ${opts.taskId}`);
  }

  const run = createTaskRun(task.id);
  const conversation = bootstrapConversation({
    // Schedule-triggered tasks use "standard" so they appear in the sidebar's
    // Scheduled section; non-schedule tasks use "background" to stay out of
    // the main conversation list.
    conversationType: opts.source === "schedule" ? undefined : "background",
    source: opts.source,
    scheduleJobId: opts.scheduleJobId,
    origin: "task",
    systemHint: `Task: ${task.title}`,
  });

  updateTaskRun(run.id, {
    conversationId: conversation.id,
    memoryScopeId: `task:${task.id}`,
  });

  // Build and register ephemeral permission rules. If the user pre-approved
  // specific tools via the preflight flow, use those instead of all requiredTools.
  const requiredTools = sanitizeToolList(
    task.requiredTools ? JSON.parse(task.requiredTools) : [],
  );
  const toolsForRules = opts.approvedTools
    ? sanitizeToolList(opts.approvedTools)
    : requiredTools;
  const rules = buildTaskRules(run.id, toolsForRules, opts.workingDir);
  setTaskRunRules(run.id, rules);

  try {
    const renderedTemplate = renderTemplate(task.template, opts.inputs ?? {});

    updateTaskRun(run.id, { status: "running", startedAt: Date.now() });

    log.info(
      { taskId: task.id, taskRunId: run.id, conversationId: conversation.id },
      "Executing task",
    );
    await processMessage(conversation.id, renderedTemplate, run.id);

    updateTaskRun(run.id, { status: "completed", finishedAt: Date.now() });

    return {
      taskRunId: run.id,
      conversationId: conversation.id,
      status: "completed",
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.warn(
      { err, taskId: task.id, taskRunId: run.id },
      "Task execution failed",
    );

    updateTaskRun(run.id, {
      status: "failed",
      error: errorMessage,
      finishedAt: Date.now(),
    });

    try {
      invalidateAssistantInferredItemsForConversation(conversation.id);
    } catch (cleanupErr) {
      log.warn(
        { err: cleanupErr, conversationId: conversation.id },
        "Failed to invalidate assistant-inferred memory items",
      );
    }

    return {
      taskRunId: run.id,
      conversationId: conversation.id,
      status: "failed",
      error: errorMessage,
    };
  } finally {
    clearTaskRunRules(run.id);
  }
}
