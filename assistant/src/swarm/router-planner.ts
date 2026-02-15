import type { Provider, Message } from '../providers/types.js';
import type { SwarmPlan, SwarmTaskNode } from './types.js';
import type { SwarmLimits } from './limits.js';
import { validateAndNormalizePlan } from './plan-validator.js';
import { ROUTER_SYSTEM_PROMPT, buildPlannerUserMessage } from './router-prompts.js';

/**
 * Generate a validated swarm plan from a user objective using an LLM.
 * Falls back to a single-coder plan if generation or validation fails.
 */
export async function generatePlan(opts: {
  objective: string;
  provider: Provider;
  model: string;
  limits: SwarmLimits;
}): Promise<SwarmPlan> {
  const { objective, provider, model, limits } = opts;

  try {
    const messages: Message[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: buildPlannerUserMessage(objective, limits.maxTasks) }],
      },
    ];

    const response = await provider.sendMessage(
      messages,
      undefined,
      ROUTER_SYSTEM_PROMPT,
      { config: { max_tokens: 2048, model } },
    );

    // Extract text from response
    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      return makeFallbackPlan(objective);
    }

    const rawPlan = parsePlanJSON(textBlock.text);
    if (!rawPlan) {
      return makeFallbackPlan(objective);
    }

    const plan: SwarmPlan = {
      objective,
      tasks: rawPlan.tasks as SwarmTaskNode[],
    };

    return validateAndNormalizePlan(plan, limits);
  } catch {
    return makeFallbackPlan(objective);
  }
}

/**
 * Parse the LLM output as a plan JSON. Handles bare JSON objects and
 * fenced code blocks.
 */
export function parsePlanJSON(raw: string): { tasks: Array<{ id: string; role: string; objective: string; dependencies: string[] }> } | null {
  // Try extracting from fenced code block first
  const fenced = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const jsonStr = fenced ? fenced[1] : raw;

  try {
    const parsed = JSON.parse(jsonStr.trim());
    if (parsed && Array.isArray(parsed.tasks)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Deterministic fallback: a single coder task for the full objective.
 */
export function makeFallbackPlan(objective: string): SwarmPlan {
  return {
    objective,
    tasks: [
      {
        id: 'fallback-coder',
        role: 'coder',
        objective,
        dependencies: [],
      },
    ],
  };
}
