import { getConfiguredProvider } from "../../providers/provider-send-message.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  ToolUseContent,
} from "../../providers/types.js";
import {
  buildRecallAgentPromptBundle,
  FINISH_RECALL_TOOL_DEFINITION,
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
import {
  extractWorkspacePathLiterals,
  inspectWorkspacePaths,
  isSafeWorkspaceRelativePath,
} from "./sources/workspace.js";
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

export interface AgenticRecallInspectDebug {
  round: number;
  paths: string[];
  reason: string;
  evidenceCount: number;
  errors?: Array<{ path: string; reason: string }>;
}

export interface AgenticRecallDebug {
  mode: "agentic" | "deterministic_fallback";
  normalizedInput: NormalizedRecallInput;
  roundLimit: number;
  roundsUsed: number;
  seedEvidenceCount: number;
  searchCalls: AgenticRecallSearchDebug[];
  inspectCalls: AgenticRecallInspectDebug[];
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

const REFERENT_QUERY_PATTERN =
  /\b(asked about|referred to|talking about|mentioned|meant by|referent)\b/i;
const DETAIL_QUERY_PATTERN =
  /\b(details?|specifics?|flavor|decoration|design|message|inscription|recipient|timing|plan)\b/i;

const DETAIL_EXPANSION_TERMS = [
  "paid",
  "delivery",
  "design",
  "inscription",
  "flavor",
  "message",
];

const DETAIL_FIELD_TERMS = new Set([
  "decoration",
  "design",
  "details",
  "detail",
  "flavor",
  "inscription",
  "message",
  "recipient",
  "specifics",
  "timing",
  "plan",
]);

const NON_SALIENT_REFERENT_TERMS = new Set([
  "a",
  "about",
  "and",
  "any",
  "asked",
  "by",
  "did",
  "does",
  "find",
  "for",
  "from",
  "is",
  "it",
  "me",
  "mean",
  "meant",
  "mention",
  "mentioned",
  "of",
  "on",
  "or",
  "referent",
  "referred",
  "that",
  "the",
  "to",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "with",
]);

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
    inspectCalls: [],
  };

  const provider = await getConfiguredProvider("recall");
  if (!provider) {
    const fallbackResult = await runSeedRecallSearch(
      normalizedInput,
      context,
      options.searchOptions,
    );
    const autoInspect = await runAutomaticWorkspaceInspection(
      normalizedInput,
      context,
      fallbackResult.evidence,
    );
    if (autoInspect.debug) {
      debug.inspectCalls.push(autoInspect.debug);
    }
    const fallbackEvidence = mergeEvidence(
      fallbackResult.evidence,
      autoInspect.evidence,
    );
    debug.seedEvidenceCount = fallbackEvidence.length;
    return deterministicFallback(
      withFallbackEvidence(fallbackResult, fallbackEvidence),
      debug,
      "no_provider",
      "No recall provider is configured.",
    );
  }

  const seedResult = await runSeedRecallSearch(
    normalizedInput,
    context,
    options.searchOptions,
  );
  let evidence = [...seedResult.evidence];
  const autoInspect = await runAutomaticWorkspaceInspection(
    normalizedInput,
    context,
    evidence,
  );
  if (autoInspect.debug) {
    debug.inspectCalls.push(autoInspect.debug);
    evidence = mergeEvidence(evidence, autoInspect.evidence);
  }
  debug.seedEvidenceCount = evidence.length;
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
      const finishResult = finishRecallFromToolUse(
        finishTool,
        promptBundle.evidence,
        debug,
      );
      if (finishResult.ok) {
        return finishResult.answer;
      }

      if (!finishResult.ok) {
        fallbackReason = "citation_validation_failed";
        fallbackDetail = finishResult.detail;
        break;
      }
    }

    const inspectTools = toolUses.filter(
      (tool) => tool.name === "inspect_workspace_paths",
    );
    const searchTools = toolUses.filter(
      (tool) => tool.name === "search_sources",
    );
    if (inspectTools.length === 0 && searchTools.length === 0) {
      fallbackReason = "no_valid_finish";
      fallbackDetail =
        "Recall provider returned no search_sources, inspect_workspace_paths, or finish_recall tool call.";
      break;
    }

    for (const inspectTool of inspectTools) {
      const inspectResult = await executeInspectWorkspacePaths(
        inspectTool.input,
        normalizedInput,
        context,
        evidence,
        round,
      );
      debug.inspectCalls.push(inspectResult.debug);
      evidence = mergeEvidence(evidence, inspectResult.evidence);
    }

    if (searchTools.length > 0) {
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
    }

    if (round === roundLimit) {
      fallbackReason = "round_limit";
      fallbackDetail = "Recall provider exhausted the configured round budget.";
    }
  }

  if (fallbackReason === "round_limit") {
    const finalFinish = await tryFinalFinishRecall({
      provider,
      normalizedInput,
      evidence,
      debug,
      context,
    });
    if (finalFinish.ok) {
      return finalFinish.answer;
    }
    fallbackReason = finalFinish.reason;
    fallbackDetail = finalFinish.detail;
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

async function runSeedRecallSearch(
  input: NormalizedRecallInput,
  context: RecallSearchContext,
  searchOptions: DeterministicRecallSearchOptions | undefined,
): Promise<DeterministicRecallSearchResult> {
  const baseResult = await runDeterministicRecallSearch(
    toRecallInput(input),
    context,
    searchOptions,
  );
  const expansionQueries = buildReferentExpansionQueries(input.query);
  if (expansionQueries.length === 0) {
    return baseResult;
  }

  let evidence = [...baseResult.evidence];
  for (const query of expansionQueries) {
    const expansionResult = await runDeterministicRecallSearch(
      {
        ...toRecallInput(input),
        query,
        depth: "fast",
        max_results: Math.min(input.maxResults, 8),
      },
      context,
      searchOptions,
    );
    evidence = mergeEvidence(expansionResult.evidence, evidence);
  }

  return withFallbackEvidence(baseResult, evidence);
}

function buildReferentExpansionQueries(query: string): string[] {
  const shouldExpandReferent = REFERENT_QUERY_PATTERN.test(query);
  const shouldExpandDetails = DETAIL_QUERY_PATTERN.test(query);
  const terms = tokenizeReferentTerms(query);
  if (terms.length === 0 || (!shouldExpandReferent && !shouldExpandDetails)) {
    return [];
  }

  const queries: string[] = [];
  const objectTerms = terms.filter((term) => !DETAIL_FIELD_TERMS.has(term));
  const searchTerms = objectTerms.length > 0 ? objectTerms : terms;
  const firstTerm = searchTerms[0];
  const lastTerm = searchTerms[searchTerms.length - 1];

  if (shouldExpandReferent && firstTerm) {
    queries.push(firstTerm);
  }

  if (shouldExpandReferent && searchTerms.length > 1) {
    queries.push(searchTerms.slice(0, 2).join(" "));
  }

  if ((shouldExpandReferent || shouldExpandDetails) && firstTerm) {
    queries.push(`${firstTerm} ${DETAIL_EXPANSION_TERMS.join(" ")}`);
  }

  if (
    shouldExpandDetails &&
    lastTerm &&
    lastTerm !== firstTerm &&
    !DETAIL_FIELD_TERMS.has(lastTerm)
  ) {
    queries.push(`${lastTerm} ${DETAIL_EXPANSION_TERMS.join(" ")}`);
  }

  return [...new Set(queries)].filter((candidate) => candidate !== query);
}

function tokenizeReferentTerms(query: string): string[] {
  const tokens = query.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  return [...new Set(tokens)].filter(
    (term) =>
      term.length >= 2 &&
      !NON_SALIENT_REFERENT_TERMS.has(term) &&
      !term.endsWith("'s"),
  );
}

async function tryFinalFinishRecall(options: {
  provider: Provider;
  normalizedInput: NormalizedRecallInput;
  evidence: readonly RecallEvidence[];
  debug: AgenticRecallDebug;
  context: RecallSearchContext;
}): Promise<
  | { ok: true; answer: AgenticRecallAnswer }
  | {
      ok: false;
      reason: AgenticRecallFallbackReason;
      detail: string;
    }
> {
  const promptBundle = buildPromptBundle(
    options.normalizedInput,
    options.evidence,
    0,
  );

  let response: ProviderResponse;
  try {
    response = await options.provider.sendMessage(
      [userTextMessage(promptBundle.prompt)],
      [FINISH_RECALL_TOOL_DEFINITION],
      undefined,
      {
        config: { callSite: "recall", temperature: 0 },
        signal: options.context.signal,
      },
    );
  } catch (err) {
    return {
      ok: false,
      reason: isAbortError(err) ? "timeout" : "provider_error",
      detail: errorToMessage(err),
    };
  }

  const finishTool = extractToolUses(response).find(
    (tool) => tool.name === "finish_recall",
  );
  if (!finishTool) {
    return {
      ok: false,
      reason: "no_valid_finish",
      detail:
        "Recall provider exhausted the search budget and did not return a final finish_recall.",
    };
  }

  const finishResult = finishRecallFromToolUse(
    finishTool,
    promptBundle.evidence,
    options.debug,
  );
  if (finishResult.ok) {
    return finishResult;
  }

  return {
    ok: false,
    reason: "citation_validation_failed",
    detail: finishResult.detail,
  };
}

function finishRecallFromToolUse(
  finishTool: ToolUseContent,
  evidence: readonly RecallEvidence[],
  debug: AgenticRecallDebug,
): { ok: true; answer: AgenticRecallAnswer } | { ok: false; detail: string } {
  const validation = validateFinishRecallPayload(finishTool.input, evidence);
  if (!validation.ok) {
    return { ok: false, detail: validation.reason };
  }

  const finish = validation.finish;
  const citedEvidence = selectCitedEvidence(evidence, finish.citationIds);
  debug.finish = {
    confidence: finish.confidence,
    citationIds: finish.citationIds,
    ...(finish.unresolved ? { unresolved: finish.unresolved } : {}),
  };

  return {
    ok: true,
    answer: {
      content: finish.answer,
      answer: finish.answer,
      evidence: citedEvidence,
      debug,
    },
  };
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

async function executeInspectWorkspacePaths(
  payload: Record<string, unknown>,
  input: NormalizedRecallInput,
  context: RecallSearchContext,
  evidence: readonly RecallEvidence[],
  round: number,
): Promise<{
  evidence: RecallEvidence[];
  debug: AgenticRecallInspectDebug;
}> {
  const reason = readSearchReason(payload.reason);
  const requestedPaths = readInspectPaths(payload.paths);
  const allowedPaths = collectInspectableWorkspacePaths(input.query, evidence);
  const acceptedPaths = requestedPaths.filter((path) => allowedPaths.has(path));
  const rejectedPaths = requestedPaths.filter(
    (path) => !allowedPaths.has(path),
  );

  const debug: AgenticRecallInspectDebug = {
    round,
    paths: requestedPaths,
    reason,
    evidenceCount: 0,
  };

  if (requestedPaths.length === 0) {
    return {
      evidence: [
        makeWorkspaceInspectionErrorEvidence({
          round,
          index: 0,
          path: "inspect_workspace_paths",
          reason: "inspect_workspace_paths paths must be non-empty strings",
        }),
      ],
      debug: {
        ...debug,
        errors: [
          {
            path: "inspect_workspace_paths",
            reason: "paths must be non-empty strings",
          },
        ],
      },
    };
  }

  const errors = rejectedPaths.map((path) => ({
    path,
    reason:
      "path was not a safe relative workspace file surfaced by the query or prior evidence",
  }));

  let inspectionEvidence: RecallEvidence[] = [];
  if (acceptedPaths.length > 0) {
    const inspectionResult = await inspectWorkspacePaths(
      acceptedPaths,
      input.query,
      context,
    );
    inspectionEvidence = inspectionResult.evidence;
    errors.push(...inspectionResult.errors);
  }

  const errorEvidence = errors.map((error, index) =>
    makeWorkspaceInspectionErrorEvidence({
      round,
      index,
      path: error.path,
      reason: error.reason,
    }),
  );
  const allEvidence = [...inspectionEvidence, ...errorEvidence];

  return {
    evidence: allEvidence,
    debug: {
      ...debug,
      evidenceCount: allEvidence.length,
      ...(errors.length > 0 ? { errors } : {}),
    },
  };
}

async function runAutomaticWorkspaceInspection(
  input: NormalizedRecallInput,
  context: RecallSearchContext,
  evidence: readonly RecallEvidence[],
): Promise<{
  evidence: RecallEvidence[];
  debug?: AgenticRecallInspectDebug;
}> {
  if (!input.sources.includes("workspace")) {
    return { evidence: [] };
  }

  const paths = collectAutomaticWorkspaceInspectionPaths(input.query, evidence);
  if (paths.length === 0) {
    return { evidence: [] };
  }

  const inspectionResult = await inspectWorkspacePaths(
    paths,
    input.query,
    context,
  );
  const debug: AgenticRecallInspectDebug = {
    round: 0,
    paths,
    reason:
      "Automatically inspect exact workspace paths surfaced by seed evidence.",
    evidenceCount: inspectionResult.evidence.length,
    ...(inspectionResult.errors.length > 0
      ? { errors: inspectionResult.errors }
      : {}),
  };
  return { evidence: inspectionResult.evidence, debug };
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

function readInspectPaths(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  ].slice(0, 5);
}

function collectAutomaticWorkspaceInspectionPaths(
  query: string,
  evidence: readonly RecallEvidence[],
): string[] {
  const paths = new Set(extractWorkspacePathLiterals(query));
  for (const item of evidence) {
    if (item.source !== "workspace") {
      continue;
    }
    for (const path of extractWorkspacePathLiterals(item.excerpt)) {
      paths.add(path);
    }
  }
  return [...paths].filter(isSafeWorkspaceRelativePath).slice(0, 3);
}

function collectInspectableWorkspacePaths(
  query: string,
  evidence: readonly RecallEvidence[],
): Set<string> {
  const paths = new Set(extractWorkspacePathLiterals(query));
  for (const item of evidence) {
    const metadataPath = item.metadata?.path;
    if (
      typeof metadataPath === "string" &&
      isSafeWorkspaceRelativePath(metadataPath)
    ) {
      paths.add(metadataPath);
    }

    for (const path of extractWorkspacePathLiterals(item.locator)) {
      paths.add(path);
    }
    for (const path of extractWorkspacePathLiterals(item.title)) {
      paths.add(path);
    }
    for (const path of extractWorkspacePathLiterals(item.excerpt)) {
      paths.add(path);
    }
  }
  return paths;
}

function makeWorkspaceInspectionErrorEvidence(options: {
  round: number;
  index: number;
  path: string;
  reason: string;
}): RecallEvidence {
  return {
    id: `workspace:inspect-error:${options.round}:${options.index}`,
    source: "workspace",
    title: "Workspace path inspection",
    locator: options.path,
    excerpt: `Could not inspect workspace path: ${options.reason}.`,
    score: 0,
    metadata: {
      retrieval: "path",
      inspectError: true,
      path: options.path,
      reason: options.reason,
    },
  };
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
