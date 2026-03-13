// Starter task intent resolution for deterministic kickoff routing.
// Exports `resolveStarterTaskIntent` as the single public entry point.
// When a `[STARTER_TASK:<task_id>]` kickoff message is detected, the session
// pipeline rewrites the message to force immediate loading of the
// onboarding-starter-tasks skill, ensuring the full playbook is available
// without embedding it in the global system prompt.

export type StarterTaskIntentResult =
  | { kind: "none" }
  | {
      kind: "starter_task";
      taskId: string;
      rewrittenContent: string;
    };

/** Known starter task IDs — must match the playbooks in onboarding-starter-tasks SKILL.md. */
const KNOWN_TASK_IDS = new Set([
  "make_it_yours",
  "research_topic",
  "research_to_ui",
]);

/** Pattern matching `[STARTER_TASK:<task_id>]` kickoff messages. */
const STARTER_TASK_PATTERN = /^\[STARTER_TASK:(\w+)\]$/;

/**
 * Resolves starter task intent from user text.
 *
 * Detects deterministic `[STARTER_TASK:<task_id>]` kickoff messages sent by
 * the dashboard when a user clicks a starter task card. On match, builds a
 * rewritten instruction that forces the onboarding-starter-tasks skill to load.
 */
export function resolveStarterTaskIntent(
  text: string,
): StarterTaskIntentResult {
  const trimmed = text.trim();
  const match = STARTER_TASK_PATTERN.exec(trimmed);
  if (!match) {
    return { kind: "none" };
  }

  const taskId = match[1];

  if (!KNOWN_TASK_IDS.has(taskId)) {
    return { kind: "none" };
  }

  const lines = [
    `The user clicked the "${taskId}" starter task card.`,
    'Please invoke the "Onboarding Starter Tasks" skill (ID: onboarding-starter-tasks) immediately using skill_load.',
    `Then follow the playbook for task "${taskId}" exactly.`,
  ];

  return {
    kind: "starter_task",
    taskId,
    rewrittenContent: lines.join("\n"),
  };
}
