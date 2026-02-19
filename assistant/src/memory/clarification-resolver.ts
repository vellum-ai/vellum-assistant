import Anthropic from '@anthropic-ai/sdk';
import { getConfig } from '../config/loader.js';
import { truncate } from '../util/truncate.js';

const DEFAULT_RESOLVER_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_RESOLVER_TIMEOUT_MS = 12_000;

const DIRECTIONAL_EXISTING_CUES = ['existing', 'old', 'previous', 'first', 'earlier', 'original'];
const DIRECTIONAL_CANDIDATE_CUES = ['candidate', 'new', 'latest', 'second', 'updated', 'instead', 'replace'];
const MERGE_CUES = ['both', 'merge', 'combine', 'together', 'depends', 'either', 'mix'];

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'because', 'been', 'before', 'being', 'between',
  'could', 'doing', 'from', 'have', 'into', 'just', 'more', 'most', 'only', 'over',
  'same', 'should', 'some', 'than', 'that', 'their', 'there', 'these', 'they', 'this',
  'those', 'were', 'what', 'when', 'where', 'which', 'while', 'with', 'would', 'your',
]);

export type ClarificationResolution =
  | 'keep_existing'
  | 'keep_candidate'
  | 'merge'
  | 'still_unclear';

export type ClarificationStrategy =
  | 'heuristic'
  | 'llm'
  | 'llm_timeout'
  | 'llm_error'
  | 'no_llm_key';

export interface ClarificationResolverInput {
  existingStatement: string;
  candidateStatement: string;
  userMessage: string;
}

export interface ClarificationResolverOptions {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}

export interface ClarificationResolverResult {
  resolution: ClarificationResolution;
  strategy: ClarificationStrategy;
  resolvedStatement: string | null;
  explanation: string;
}

export async function resolveConflictClarification(
  input: ClarificationResolverInput,
  options?: ClarificationResolverOptions,
): Promise<ClarificationResolverResult> {
  const heuristicResult = resolveWithHeuristics(input);
  if (heuristicResult) return heuristicResult;

  const config = getConfig();
  const apiKey = options?.apiKey ?? config.apiKeys.anthropic ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      resolution: 'still_unclear',
      strategy: 'no_llm_key',
      resolvedStatement: null,
      explanation: 'No Anthropic API key available for clarification fallback.',
    };
  }

  try {
    return await resolveWithLlm(input, {
      apiKey,
      model: options?.model ?? DEFAULT_RESOLVER_MODEL,
      timeoutMs: options?.timeoutMs ?? DEFAULT_RESOLVER_TIMEOUT_MS,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'clarification_resolver_timeout') {
      return {
        resolution: 'still_unclear',
        strategy: 'llm_timeout',
        resolvedStatement: null,
        explanation: 'Clarification resolver timed out.',
      };
    }
    return {
      resolution: 'still_unclear',
      strategy: 'llm_error',
      resolvedStatement: null,
      explanation: `Clarification resolver failed: ${truncate(message, 300, '')}`,
    };
  }
}

function resolveWithHeuristics(input: ClarificationResolverInput): ClarificationResolverResult | null {
  const normalizedMessage = normalize(input.userMessage);
  if (!normalizedMessage) return null;

  const lowerMessage = normalizedMessage.toLowerCase();

  const hasExistingCue = containsAnyCue(lowerMessage, DIRECTIONAL_EXISTING_CUES);
  const hasCandidateCue = containsAnyCue(lowerMessage, DIRECTIONAL_CANDIDATE_CUES);
  const hasMergeCue = containsAnyCue(lowerMessage, MERGE_CUES);

  // When multiple cue categories match, delegate to LLM to avoid misclassification
  const matchCount = [hasExistingCue, hasCandidateCue, hasMergeCue].filter(Boolean).length;
  if (matchCount > 1) return null;

  if (hasMergeCue) {
    return {
      resolution: 'merge',
      strategy: 'heuristic',
      resolvedStatement: buildMergedStatement(input),
      explanation: 'User response includes merge cues.',
    };
  }

  if (hasExistingCue) {
    return {
      resolution: 'keep_existing',
      strategy: 'heuristic',
      resolvedStatement: null,
      explanation: 'User response explicitly points to existing/old statement.',
    };
  }

  if (hasCandidateCue) {
    return {
      resolution: 'keep_candidate',
      strategy: 'heuristic',
      resolvedStatement: null,
      explanation: 'User response explicitly points to candidate/new statement.',
    };
  }

  const messageTokens = tokenize(normalizedMessage);
  const existingOverlap = overlapScore(messageTokens, tokenize(input.existingStatement));
  const candidateOverlap = overlapScore(messageTokens, tokenize(input.candidateStatement));

  if (existingOverlap >= 2 && existingOverlap >= candidateOverlap + 1) {
    return {
      resolution: 'keep_existing',
      strategy: 'heuristic',
      resolvedStatement: null,
      explanation: 'User response overlaps more with existing statement details.',
    };
  }

  if (candidateOverlap >= 2 && candidateOverlap >= existingOverlap + 1) {
    return {
      resolution: 'keep_candidate',
      strategy: 'heuristic',
      resolvedStatement: null,
      explanation: 'User response overlaps more with candidate statement details.',
    };
  }

  if (existingOverlap > 0 && candidateOverlap > 0) {
    return {
      resolution: 'merge',
      strategy: 'heuristic',
      resolvedStatement: buildMergedStatement(input),
      explanation: 'User response overlaps with both statements.',
    };
  }

  return null;
}

async function resolveWithLlm(
  input: ClarificationResolverInput,
  options: { apiKey: string; model: string; timeoutMs: number },
): Promise<ClarificationResolverResult> {
  const client = new Anthropic({ apiKey: options.apiKey });
  const userPrompt = [
    'You are resolving a memory clarification response.',
    '',
    `Existing statement: ${input.existingStatement}`,
    `Candidate statement: ${input.candidateStatement}`,
    `User clarification: ${input.userMessage}`,
  ].join('\n');

  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), options.timeoutMs);

  try {
  const response = await client.messages.create({
      model: options.model,
      max_tokens: 256,
      system: [
        'Classify the user clarification for conflicting memory statements.',
        'Return exactly one resolution:',
        '- keep_existing',
        '- keep_candidate',
        '- merge',
        '- still_unclear',
      ].join('\n'),
      tools: [{
        name: 'resolve_conflict_clarification',
        description: 'Resolve a pending memory contradiction using user clarification.',
        input_schema: {
          type: 'object' as const,
          properties: {
            resolution: {
              type: 'string',
              enum: ['keep_existing', 'keep_candidate', 'merge', 'still_unclear'],
            },
            resolved_statement: {
              type: 'string',
              description: 'Required only when resolution is merge.',
            },
            explanation: {
              type: 'string',
              description: 'One short rationale for the classification.',
            },
          },
          required: ['resolution', 'explanation'],
        },
      }],
      tool_choice: { type: 'tool' as const, name: 'resolve_conflict_clarification' },
      messages: [{ role: 'user' as const, content: userPrompt }],
    }, { signal: abortController.signal });
    clearTimeout(timer);

    const toolBlock = response.content.find((block) => block.type === 'tool_use');
    if (!toolBlock || toolBlock.type !== 'tool_use') {
      throw new Error('No tool_use block in clarification resolver response.');
    }

    const parsed = toolBlock.input as {
      resolution?: string;
      resolved_statement?: string;
      explanation?: string;
    };

    if (!isResolution(parsed.resolution)) {
      throw new Error(`Invalid clarification resolution: ${String(parsed.resolution)}`);
    }

    const resolvedStatement = parsed.resolution === 'merge'
      ? normalize(parsed.resolved_statement ?? buildMergedStatement(input)) || buildMergedStatement(input)
      : null;

    return {
      resolution: parsed.resolution,
      strategy: 'llm',
      resolvedStatement,
      explanation: truncate(normalize(parsed.explanation ?? 'Resolved via LLM fallback.'), 500, ''),
    };
  } catch (err) {
    clearTimeout(timer);
    if (abortController.signal.aborted) {
      throw new Error('clarification_resolver_timeout');
    }
    throw err;
  }
}

function isResolution(value: string | undefined): value is ClarificationResolution {
  return value === 'keep_existing'
    || value === 'keep_candidate'
    || value === 'merge'
    || value === 'still_unclear';
}

function containsAnyCue(input: string, cues: readonly string[]): boolean {
  return cues.some((cue) => new RegExp(`\\b${cue}\\b`).test(input));
}

function overlapScore(left: Set<string>, right: Set<string>): number {
  let score = 0;
  for (const token of left) {
    if (right.has(token)) score += 1;
  }
  return score;
}

function tokenize(input: string): Set<string> {
  const words = input
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((word) => word.trim())
    .filter((word) => word.length >= 4 && !STOP_WORDS.has(word));
  return new Set(words);
}

function normalize(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

function buildMergedStatement(input: ClarificationResolverInput): string {
  const normalizedUserMessage = normalize(input.userMessage);
  if (normalizedUserMessage.length >= 8 && normalizedUserMessage.length <= 320) {
    return normalizedUserMessage;
  }
  const existing = truncate(normalize(input.existingStatement), 140, '');
  const candidate = truncate(normalize(input.candidateStatement), 140, '');
  return truncate(`Merged clarification: ${existing}; ${candidate}`, 320, '');
}
