import { getConfiguredProvider } from "../../providers/provider-send-message.js";
import type {
  Message,
  ProviderResponse,
  ToolUseContent,
} from "../../providers/types.js";
import {
  buildRecallAgentPromptBundle,
  RECALL_AGENT_TOOL_DEFINITIONS,
  validateFinishRecallPayload,
} from "./agent-protocol.js";
import { formatDeterministicRecallAnswer } from "./format.js";
import {
  isRecallSource,
  type NormalizedRecallInput,
  normalizeRecallInput,
  normalizeRecallMaxResults,
  normalizeRecallSources,
} from "./limits.js";
import {
  type DeterministicRecallSearchOptions,
  type DeterministicRecallSearchResult,
  runDeterministicRecallSearch,
} from "./search.js";
import type {
  RecallAnswer,
  RecallEvidence,
  RecallInput,
  RecallSearchContext,
  RecallSource,
} from "./types.js";

export type AgenticRecallFallbackReason =
  | "no_provider"
  | "provider_error"
  | "timeout"
  | "no_valid_finish"
  | "round_limit"
  | "citation_validation_failed";

export interface AgenticRecallSearchDebug {
  round: number;
  query: string;
  sources: RecallSource[];
  limit: number;
  reason: string;
  evidenceCount: number;
  error?: string;
}

export interface AgenticRecallDebug {
  mode: "agentic" | "deterministic_fallback";
  normalizedInput: NormalizedRecallInput;
  roundLimit: number;
  roundsUsed: number;
  seedEvidenceCount: number;
  searchCalls: AgenticRecallSearchDebug[];
  finish?: {
    confidence: string;
    citationIds: string[];
    unresolved?: string[];
  };
  fallbackReason?: AgenticRecallFallbackReason;
  fallbackDetail?: string;
}

export interface AgenticRecallAnswer extends RecallAnswer {
  content: string;
  debug: AgenticRecallDebug;
}

export interface RunAgenticRecallOptions {
  searchOptions?: DeterministicRecallSearchOptions;
}

export async function runAgenticRecall(
  input: RecallInput,
  context: RecallSearchContext,
  options: RunAgenticRecallOptions = {},
): Promise<AgenticRecallAnswer> {
  const normalizedInput = normalizeRecallInput(input);
  const roundLimit = normalizedInput.sourceRounds;
  const debug: AgenticRecallDebug = {
    mode: "agentic",
    normalizedInput,
    roundLimit,
    roundsUsed: 0,
    seedEvidenceCount: 0,
    searchCalls: [],
  };

  const provider = await getConfiguredProvider("recall");
  if (!provider) {
    const fallbackResult = await runDeterministicRecallSearch(
      toRecallInput(normalizedInput),
      context,
      options.searchOptions,
    );
    debug.seedEvidenceCount = fallbackResult.evidence.length;
    return deterministicFallback(
      fallbackResult,
      debug,
      "no_provider",
      "No recall provider is configured.",
    );
  }

  const seedResult = await runDeterministicRecallSearch(
    toRecallInput(normalizedInput),
    context,
    options.searchOptions,
  );
  debug.seedEvidenceCount = seedResult.evidence.length;
  let evidence = [...seedResult.evidence];
  let fallbackReason: AgenticRecallFallbackReason = "no_valid_finish";
  let fallbackDetail = "Recall provider did not return a valid finish_recall.";

  for (let round = 1; round <= roundLimit; round++) {
    debug.roundsUsed = round;
    const promptBundle = buildPromptBundle(
      normalizedInput,
      evidence,
      roundLimit,
    );

    let response: ProviderResponse;
    try {
      response = await provider.sendMessage(
        [userTextMessage(promptBundle.prompt)],
        [...RECALL_AGENT_TOOL_DEFINITIONS],
        undefined,
        {
          config: { callSite: "recall", temperature: 0 },
          signal: context.signal,
        },
      );
    } catch (err) {
      fallbackReason = isAbortError(err) ? "timeout" : "provider_error";
      fallbackDetail = errorToMessage(err);
      break;
    }

    const toolUses = extractToolUses(response);
    const finishTool = toolUses.find((tool) => tool.name === "finish_recall");
    if (finishTool) {
      const validation = validateFinishRecallPayload(
        finishTool.input,
        promptBundle.evidence,
      );
      if (!validation.ok) {
        fallbackReason = "citation_validation_failed";
        fallbackDetail = validation.reason;
        break;
      }

      const finish = validation.finish;
      const citedEvidence = selectCitedEvidence(
        promptBundle.evidence,
        finish.citationIds,
      );
      debug.finish = {
        confidence: finish.confidence,
        citationIds: finish.citationIds,
        ...(finish.unresolved ? { unresolved: finish.unresolved } : {}),
      };

      return {
        content: finish.answer,
        answer: finish.answer,
        evidence: citedEvidence,
        debug,
      };
    }

    const searchTools = toolUses.filter(
      (tool) => tool.name === "search_sources",
    );
    if (searchTools.length === 0) {
      fallbackReason = "no_valid_finish";
      fallbackDetail =
        "Recall provider returned no search_sources or finish_recall tool call.";
      break;
    }

    const remainingSearchBudget = roundLimit - debug.searchCalls.length;
    if (remainingSearchBudget <= 0) {
      fallbackReason = "round_limit";
      fallbackDetail =
        "Recall provider exhausted the configured search budget.";
      break;
    }

    for (const searchTool of searchTools.slice(0, remainingSearchBudget)) {
      const searchResult = await executeSearchSources(
        searchTool.input,
        normalizedInput,
        context,
        round,
        options.searchOptions,
      );
      debug.searchCalls.push(searchResult.debug);
      evidence = mergeEvidence(evidence, searchResult.evidence);
    }

    if (round === roundLimit) {
      fallbackReason = "round_limit";
      fallbackDetail = "Recall provider exhausted the configured round budget.";
    }
  }

  return deterministicFallback(
    withFallbackEvidence(seedResult, evidence),
    debug,
    fallbackReason,
    fallbackDetail,
  );
}

function buildPromptBundle(
  input: NormalizedRecallInput,
  evidence: readonly RecallEvidence[],
  roundLimit: number,
): ReturnType<typeof buildRecallAgentPromptBundle> {
  return buildRecallAgentPromptBundle({
    query: input.query,
    availableSources: input.sources,
    evidence,
    maxSearchCalls: roundLimit,
  });
}

function userTextMessage(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

function extractToolUses(response: ProviderResponse): ToolUseContent[] {
  return response.content.filter(
    (block): block is ToolUseContent => block.type === "tool_use",
  );
}

async function executeSearchSources(
  payload: Record<string, unknown>,
  input: NormalizedRecallInput,
  context: RecallSearchContext,
  round: number,
  searchOptions: DeterministicRecallSearchOptions | undefined,
): Promise<{
  evidence: RecallEvidence[];
  debug: AgenticRecallSearchDebug;
}> {
  const query = readSearchQuery(payload.query);
  const reason = readSearchReason(payload.reason);
  const rawLimit = readSearchLimit(payload.limit);
  const limit =
    rawLimit === undefined
      ? input.maxResults
      : normalizeRecallMaxResults(rawLimit);
  const sources = narrowSearchSources(payload.sources, input.sources);

  const debug: AgenticRecallSearchDebug = {
    round,
    query,
    sources,
    limit,
    reason,
    evidenceCount: 0,
  };

  if (!query || sources.length === 0) {
    return {
      evidence: [],
      debug: {
        ...debug,
        error: !query
          ? "search_sources query must be a non-empty string"
          : "search_sources requested no allowed local sources",
      },
    };
  }

  try {
    const result = await runDeterministicRecallSearch(
      {
        query,
        sources,
        max_results: limit,
        depth: "fast",
      },
      context,
      searchOptions,
    );
    return {
      evidence: result.evidence,
      debug: { ...debug, evidenceCount: result.evidence.length },
    };
  } catch (err) {
    return {
      evidence: [],
      debug: { ...debug, error: errorToMessage(err) },
    };
  }
}

function readSearchQuery(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readSearchReason(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readSearchLimit(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function narrowSearchSources(
  value: unknown,
  allowedSources: readonly RecallSource[],
): RecallSource[] {
  const allowed = new Set(allowedSources);
  const requested = Array.isArray(value)
    ? normalizeRequestedSources(value)
    : [...allowedSources];

  return requested.filter((source) => allowed.has(source));
}

function normalizeRequestedSources(value: readonly unknown[]): RecallSource[] {
  const sources = value.filter(isRecallSource);
  return sources.length > 0 ? normalizeRecallSources(sources) : [];
}

function mergeEvidence(
  existing: readonly RecallEvidence[],
  next: readonly RecallEvidence[],
): RecallEvidence[] {
  const seen = new Set(existing.map((item) => item.id));
  const merged = [...existing];

  for (const item of next) {
    if (seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    merged.push(item);
  }

  return merged;
}

function toRecallInput(input: NormalizedRecallInput): RecallInput {
  return {
    query: input.query,
    sources: input.sources,
    max_results: input.maxResults,
    depth: input.depth,
  };
}

function selectCitedEvidence(
  evidence: readonly RecallEvidence[],
  citationIds: readonly string[],
): RecallEvidence[] {
  const byId = new Map(evidence.map((item) => [item.id, item]));
  return citationIds.flatMap((id) => {
    const item = byId.get(id);
    return item ? [item] : [];
  });
}

function withFallbackEvidence(
  result: DeterministicRecallSearchResult,
  evidence: readonly RecallEvidence[],
): DeterministicRecallSearchResult {
  const evidenceCountBySource = new Map<RecallSource, number>();
  for (const item of evidence) {
    evidenceCountBySource.set(
      item.source,
      (evidenceCountBySource.get(item.source) ?? 0) + 1,
    );
  }

  return {
    ...result,
    evidence: [...evidence],
    searchedSources: result.searchedSources.map((note) => ({
      ...note,
      evidenceCount: evidenceCountBySource.get(note.source) ?? 0,
    })),
  };
}

function deterministicFallback(
  result: DeterministicRecallSearchResult,
  debug: AgenticRecallDebug,
  reason: AgenticRecallFallbackReason,
  detail: string,
): AgenticRecallAnswer {
  const fallback = formatDeterministicRecallAnswer(result);
  return {
    content: fallback.answer,
    answer: fallback.answer,
    evidence: fallback.evidence,
    debug: {
      ...debug,
      mode: "deterministic_fallback",
      fallbackReason: reason,
      fallbackDetail: detail,
    },
  };
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function errorToMessage(err: unknown): string {
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return String(err);
}
