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

const STEERING_BODY = `You have an \`advisor\` tool backed by a stronger reviewer model. It takes NO parameters — calling it forwards your entire conversation automatically (the task, every tool call, every result). Call advisor BEFORE you start building or implementing: once you understand what's being asked, consult it to shape the plan — it can lay out the plan when you don't have one yet, or pressure-test and sharpen a plan you've already drafted. Orient yourself first (read the relevant files, understand the task), then call advisor before you commit to an approach and start producing work. Also call it when you get stuck, when you're weighing a change in direction, and once before you declare the task done. Give its guidance serious weight; only override it when primary-source evidence contradicts a specific claim, and say so when you do.`;

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
 *
 * `runtimeContext`, when present, carries the agent's situational context that
 * lives outside its system prompt — available tools and skills, workspace /
 * project context, and recalled memory (see `buildAdvisorContext`) — so the
 * advisor can ground its recommendations in what the agent can actually do.
 */
/**
 * The tools the consult actually hands the advisor this turn. Each is gated on
 * a runtime capability (`read_file` on a resolved workspace, `web_search` on a
 * provider with native server-side search), so the system prompt must only
 * advertise what's truly callable — otherwise the advisor is told it can do
 * something the consult never attached.
 */
export interface AdvisorCapabilities {
  /** The advisor may call `read_file` to read files in the agent's workspace. */
  canReadFiles?: boolean;
  /** The advisor may call `web_search` for current information. */
  webSearch?: boolean;
}

export function buildAdvisorSystem(
  originalSystemPrompt: string | null,
  runtimeContext?: string | null,
  capabilities?: AdvisorCapabilities,
): string {
  const base = `You are a senior advisor consulted by another AI agent working on a task — most often at the planning stage, before it starts building, but sometimes partway through. The entire conversation above is the agent's working context: its task or goal, every tool call it has made, and every result it has seen. The agent has paused to consult you because you bring a second, independent perspective it cannot get from inside its own reasoning loop. Your job is to maximize its odds of completing the task correctly and efficiently.

Evaluate the work along these dimensions, and lead with whatever matters most right now:

- Approach & plan: If the agent has already drafted a plan or chosen an approach, pressure-test it — is it the right one, or is there a materially better path? If it hasn't committed to one yet, lay out a concrete plan for how to proceed. Either way, be specific about the path you would take and why.
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
  let prompt = base;

  const toolLines: string[] = [];
  if (capabilities?.canReadFiles) {
    toolLines.push(
      "- `read_file`: open a file in the agent's workspace (path relative to its working directory) and read its line-numbered contents. Use it to check the agent's claims against the actual code and to inspect the specific files its plan hinges on — don't speculate about a file you can simply open.",
    );
  }
  if (capabilities?.webSearch) {
    toolLines.push(
      "- `web_search`: search the web for current information. Reach for it when a decision turns on a time-sensitive or external fact you're unsure of, rather than assuming.",
    );
  }
  if (toolLines.length > 0) {
    prompt += `\n\nYou have tools for this consultation — use them to ground your advice in evidence before you give it, not after:\n${toolLines.join("\n")}`;
  }

  if (originalSystemPrompt) {
    prompt += `\n\nFor context, the agent is operating under this system prompt:\n<agent_system_prompt>\n${originalSystemPrompt}\n</agent_system_prompt>`;
  }
  if (runtimeContext) {
    prompt += `\n\nThe agent's runtime context — the tools and skills available to it, the loaded workspace/project context, and relevant memory — follows. Ground your recommendations in what the agent can actually do and what is around it; reference specific tools, skills, files, or memory where relevant.\n<agent_runtime_context>\n${runtimeContext}\n</agent_runtime_context>`;
  }
  return prompt;
}

/**
 * The final user turn appended to the transcript for the advisor sub-call. Asks
 * for guidance; imposes no length limit — the advisor decides how much to say.
 */
export function advisorRequestText(): string {
  return `Review the conversation above — the task, the tool calls, and their results — and give focused strategic guidance on how to proceed.`;
}
