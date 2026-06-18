/**
 * Prompt fragments for the advisor plugin:
 *  - `appendSteering` / `stripSteering` — the executor-facing steering block the
 *    `pre-model-call` hook injects so the model reaches for the advisor tool at
 *    the right times.
 *  - `buildAdvisorSystem` / `advisorRequestText` — the advisor-facing framing for
 *    the consult itself.
 */

/** Idempotency marker; the steering block is appended at the end of the prompt. */
export const STEERING_MARKER = "<!-- advisor:steering -->";

const STEERING_BODY = `You have an \`advisor\` tool backed by a stronger reviewer model. It takes NO parameters — calling it forwards your entire conversation automatically (the task, every tool call, every result). Call advisor BEFORE substantive work — before writing, before committing to an interpretation, before building on an assumption. Orientation (reading files, fetching a source) is not substantive work; do that first, then call advisor. Also call it when stuck, when changing approach, and once before you declare the task done. Give its guidance serious weight; only override it when primary-source evidence contradicts a specific claim, and say so when you do.`;

const ADVISOR_STEERING = `${STEERING_MARKER}\n${STEERING_BODY}`;

/** Append the steering block to the executor's system prompt (idempotent). */
export function appendSteering(systemPrompt: string | null): string | null {
  if (systemPrompt === null) return null;
  if (systemPrompt.includes(STEERING_MARKER)) return systemPrompt;
  return `${systemPrompt}\n\n${ADVISOR_STEERING}`;
}

/** Remove a previously-appended steering block, recovering the original prompt. */
export function stripSteering(systemPrompt: string | null): string | null {
  if (systemPrompt === null) return null;
  const idx = systemPrompt.indexOf(STEERING_MARKER);
  if (idx === -1) return systemPrompt;
  return systemPrompt.slice(0, idx).trimEnd();
}

/**
 * System prompt for the advisor sub-call. Frames the advisor's role and, for
 * context, quotes the executor's own system prompt (as the advisor tool does —
 * the advisor sees the system prompt as context about the executor's task).
 */
export function buildAdvisorSystem(
  originalSystemPrompt: string | null,
): string {
  const base = `You are a senior technical advisor consulted by another AI agent partway through a task. You can see the agent's full conversation above: its task, every tool call it has made, and every result it has seen. Give concise, high-leverage strategic guidance — the right approach, the key risk or failure mode to avoid, and the single most important next step. Do not role-play as the agent or produce its final deliverable; advise it. If the agent is already on track, say so briefly and sharpen its plan.`;
  if (!originalSystemPrompt) return base;
  return `${base}\n\nFor context, the agent is operating under this system prompt:\n<agent_system_prompt>\n${originalSystemPrompt}\n</agent_system_prompt>`;
}

/**
 * The final user turn appended to the transcript for the advisor sub-call. Asks
 * for guidance; imposes no length limit — the advisor decides how much to say.
 */
export function advisorRequestText(): string {
  return `Review the conversation above — the task, the tool calls, and their results — and give focused strategic guidance on how to proceed.`;
}
