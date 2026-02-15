import type { SwarmRole, SwarmTaskResult } from './types.js';

/**
 * Build a role-specific worker prompt for a swarm task.
 */
export function buildWorkerPrompt(opts: {
  role: SwarmRole;
  objective: string;
  upstreamContext?: string;
  dependencyOutputs?: Array<{ taskId: string; summary: string }>;
}): string {
  const parts: string[] = [];

  parts.push(`You are a ${opts.role} worker in a swarm. Your objective:\n${opts.objective}`);

  if (opts.upstreamContext) {
    parts.push(`\nContext from the orchestrator:\n${opts.upstreamContext}`);
  }

  if (opts.dependencyOutputs && opts.dependencyOutputs.length > 0) {
    parts.push('\nOutputs from prerequisite tasks:');
    for (const dep of opts.dependencyOutputs) {
      parts.push(`- [${dep.taskId}]: ${dep.summary}`);
    }
  }

  parts.push(WORKER_OUTPUT_CONTRACT);

  return parts.join('\n');
}

const WORKER_OUTPUT_CONTRACT = `

When you are finished, output your result as a single fenced JSON block:

\`\`\`json
{
  "summary": "Brief summary of what you accomplished",
  "artifacts": ["list of file paths, code snippets, or other outputs"],
  "issues": ["list of problems encountered, if any"],
  "nextSteps": ["suggested follow-up actions, if any"]
}
\`\`\`

If you cannot produce valid JSON, just write a plain-text summary.`;

/**
 * Parse the worker's raw output into a structured result shape.
 * Prefers a fenced JSON block; falls back to treating the entire output as a summary.
 */
export function parseWorkerOutput(raw: string): Pick<SwarmTaskResult, 'summary' | 'artifacts' | 'issues' | 'nextSteps'> {
  const jsonBlocks = Array.from(raw.matchAll(/```json\s*\n([\s\S]*?)\n```/g));
  const jsonMatch = jsonBlocks.length > 0 ? jsonBlocks[jsonBlocks.length - 1] : null;
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      return {
        summary: typeof parsed.summary === 'string' ? parsed.summary : raw.slice(0, 500),
        artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
        issues: Array.isArray(parsed.issues) ? parsed.issues : [],
        nextSteps: Array.isArray(parsed.nextSteps) ? parsed.nextSteps : [],
      };
    } catch {
      // JSON parse failed — fall through to raw summary
    }
  }

  return {
    summary: raw.slice(0, 500),
    artifacts: [],
    issues: [],
    nextSteps: [],
  };
}
