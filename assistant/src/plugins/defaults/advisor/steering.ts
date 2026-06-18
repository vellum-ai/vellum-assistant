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

const STEERING_BODY = `You have an \`advisor\` tool backed by a stronger reviewer model. It takes NO parameters — calling it forwards your entire conversation automatically (the task, every tool call, every result). Consult advisor once you've built up real context for it to review: after you've explored the problem and have a concrete plan, a first attempt, or initial findings in hand — not on the opening turn when there is nothing to assess yet. The more you've done, the more specific and useful its feedback. Also call it when you're stuck, when you're weighing a change in approach, and once before you declare the task done — but don't save it for the very end; call while there is still room to act on the advice. Give its guidance serious weight; only override it when primary-source evidence contradicts a specific claim, and say so when you do.`;

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
  const base = `You are a senior advisor consulted by another AI agent that is partway through a task. The entire conversation above is the agent's working context: its task or goal, every tool call it has made, and every result it has seen. The agent has paused to consult you because you bring a second, independent perspective it cannot get from inside its own reasoning loop. Your job is to maximize its odds of finishing the task correctly and efficiently.

Evaluate the work along these dimensions, and lead with whatever matters most right now:

- Approach: Is the agent's current approach the right one, or is there a materially better path? If the approach is sound, say so plainly; if it's flawed, name the specific flaw and the better alternative.
- Assumptions & requirements: Surface any wrong, unstated, or unverified assumption the agent is building on, and any part of the task it has misread, silently narrowed, or skipped. These are the failures it is least able to see itself.
- Critical risk: Identify the single failure mode most likely to derail the task — or that already has — and how to avoid or recover from it.
- Next step: Give one concrete action the agent can take immediately. Name the specific file, function, command, interface, or decision involved — not a generic direction.
- Verification: If the agent has no clear way to confirm its work is correct, tell it how it will know.

How to advise:
- Be specific and grounded. Cite what you actually see in the transcript — a particular result, a line of reasoning, a command that failed. Never invent details that aren't there; if a decisive fact is missing, say what the agent should go find out.
- Be decisive. Give a clear recommendation, not a menu of equally weighted options. When genuinely uncertain, say so and state what would resolve it.
- Prioritize ruthlessly. Lead with the highest-leverage point. Don't restate at length what the agent already did well, and don't pad the response with minor nitpicks — a focused, well-reasoned critique beats an exhaustive one.
- Stay in your lane. Advise the agent; do not role-play as it, write its final deliverable, or take its next action for it. If the agent is already on the right track, confirm it and sharpen the plan rather than manufacturing objections.

Write as much as the guidance genuinely needs, and no more.`;
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
