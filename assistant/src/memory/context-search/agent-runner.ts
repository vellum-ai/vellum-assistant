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
  type RecallAgentFinish,
  validateFinishRecallPayload,
} from "./agent-protocol.js";
import {
  formatDeterministicRecallAnswer,
  formatRecallFooter,
} from "./format.js";
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
  isAutoInjectedPkbContextEvidence,
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
  | "citation_validation_failed"
  | "finish_answer_validation_failed";

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
const QUESTION_QUERY_PATTERN = /\b(where|what|why|how)\b/i;
const LOCATION_QUERY_PATTERN =
  /\b(where|live|lives|lived|living|residence|home|address|location|located)\b/i;
const LEAD_IN_QUERY_PATTERN =
  /\b(led to|lead to|leads to|what led|why|how did|chain|context|cause|reason)\b/i;

const LOW_CONFIDENCE_AVAILABLE_EVIDENCE_MAX_ITEMS = 5;
const AVAILABLE_EVIDENCE_EXCERPT_MAX_CHARS = 220;

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

const LOCATION_FIELD_TERMS = new Set([
  "address",
  "home",
  "live",
  "lived",
  "lives",
  "living",
  "located",
  "location",
  "residence",
  "where",
]);

const LEAD_IN_FIELD_TERMS = new Set([
  "cause",
  "chain",
  "context",
  "did",
  "how",
  "lead",
  "leads",
  "led",
  "reason",
  "to",
  "what",
  "why",
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

const FINISH_NEGATIVE_PATTERNS = [
  /\bavailable evidence does not contain\b/i,
  /\bavailable evidence doesn't contain\b/i,
  /\bevidence does not contain\b/i,
  /\bevidence doesn't contain\b/i,
  /\bdoes not contain information\b/i,
  /\bdoesn't contain information\b/i,
  /\bno (?:reliable |available |relevant )?(?:evidence|information|results|answer)\b/i,
  /\bnot enough evidence\b/i,
  /\binsufficient evidence\b/i,
  /\bunable to (?:answer|determine|find|provide)\b/i,
  /\bcannot (?:answer|determine|find|provide)\b/i,
  /\bcan't (?:answer|determine|find|provide)\b/i,
  /\bonly the locator path\b/i,
  /\bno text\b/i,
];

const PKB_RELATIVE_PATH_PREFIXES = [
  "archive/",
  "dpo/",
  "essentials.md",
  "INDEX.md",
  "intimate/",
  "people/",
  "preferences/",
  "procedures/",
  "schedule/",
  "us-arcs/",
];

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
        evidence,
        debug,
        normalizedInput,
        withFallbackEvidence(seedResult, evidence),
      );
      if (finishResult.ok) {
        return finishResult.answer;
      }

      if (!finishResult.ok) {
        fallbackReason = finishResult.reason;
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
      searchResult: withFallbackEvidence(seedResult, evidence),
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
  const shouldExpandQuestion = QUESTION_QUERY_PATTERN.test(query);
  const shouldExpandLocation = LOCATION_QUERY_PATTERN.test(query);
  const shouldExpandLeadIn = LEAD_IN_QUERY_PATTERN.test(query);
  const terms = tokenizeReferentTerms(query);
  if (
    terms.length === 0 ||
    (!shouldExpandReferent && !shouldExpandDetails && !shouldExpandQuestion)
  ) {
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

  if (shouldExpandQuestion && !shouldExpandLocation && terms.length > 1) {
    queries.push(terms.join(" "));
  }

  if (shouldExpandLocation && firstTerm) {
    const entityTerms = terms.filter((term) => !LOCATION_FIELD_TERMS.has(term));
    const entity = entityTerms[0] ?? firstTerm;
    queries.push(`${entity} home address location`);
    queries.push(`${entity} lives residence`);
  }

  if (shouldExpandLeadIn && terms.length > 1) {
    const leadTerms = terms.filter((term) => !LEAD_IN_FIELD_TERMS.has(term));
    const focusedTerms = leadTerms.length > 0 ? leadTerms : terms;
    queries.push(focusedTerms.join(" "));
    if (focusedTerms.length > 1) {
      queries.push(`${focusedTerms.join(" ")} context reason before chain`);
    }
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
  searchResult: DeterministicRecallSearchResult;
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
    options.evidence,
    options.debug,
    options.normalizedInput,
    options.searchResult,
  );
  if (finishResult.ok) {
    return finishResult;
  }

  return {
    ok: false,
    reason: finishResult.reason,
    detail: finishResult.detail,
  };
}

function finishRecallFromToolUse(
  finishTool: ToolUseContent,
  promptEvidence: readonly RecallEvidence[],
  allEvidence: readonly RecallEvidence[],
  debug: AgenticRecallDebug,
  input: NormalizedRecallInput,
  searchResult: DeterministicRecallSearchResult,
):
  | { ok: true; answer: AgenticRecallAnswer }
  | { ok: false; reason: AgenticRecallFallbackReason; detail: string } {
  const validation = validateFinishRecallPayload(
    finishTool.input,
    promptEvidence,
  );
  if (!validation.ok) {
    return {
      ok: false,
      reason: "citation_validation_failed",
      detail: validation.reason,
    };
  }

  const finish = validation.finish;
  const answerValidation = validateFinishAnswerAgainstEvidence(
    input.query,
    finish,
    allEvidence,
  );
  if (!answerValidation.ok) {
    return {
      ok: false,
      reason: "finish_answer_validation_failed",
      detail: answerValidation.reason,
    };
  }

  const citedEvidence = selectCitedEvidence(promptEvidence, finish.citationIds);
  debug.finish = {
    confidence: finish.confidence,
    citationIds: finish.citationIds,
    ...(finish.unresolved ? { unresolved: finish.unresolved } : {}),
  };
  const content = formatAgenticRecallContent({
    answer: finish.answer,
    availableEvidence: shouldAppendAvailableEvidence(finish)
      ? selectAvailableEvidence(input.query, allEvidence, citedEvidence)
      : [],
    footer: formatRecallFooter({
      searchedSources: searchResult.searchedSources,
      inspectCalls: debug.inspectCalls,
    }),
  });

  return {
    ok: true,
    answer: {
      content,
      answer: content,
      evidence: citedEvidence,
      debug,
    },
  };
}

function validateFinishAnswerAgainstEvidence(
  query: string,
  finish: RecallAgentFinish,
  evidence: readonly RecallEvidence[],
): { ok: true } | { ok: false; reason: string } {
  if (!isNegativeOrIncompleteFinish(finish)) {
    return { ok: true };
  }

  const relevantEvidence = selectRelevantEvidence(query, evidence);
  if (relevantEvidence.length === 0) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: "negative_or_incomplete_finish_with_relevant_evidence",
  };
}

function isNegativeOrIncompleteFinish(finish: RecallAgentFinish): boolean {
  const finishText = [finish.answer, ...(finish.unresolved ?? [])].join("\n");
  return FINISH_NEGATIVE_PATTERNS.some((pattern) => pattern.test(finishText));
}

function shouldAppendAvailableEvidence(finish: RecallAgentFinish): boolean {
  return finish.confidence === "low" || (finish.unresolved?.length ?? 0) > 0;
}

function selectAvailableEvidence(
  query: string,
  evidence: readonly RecallEvidence[],
  citedEvidence: readonly RecallEvidence[],
): RecallEvidence[] {
  return dedupeEvidenceById([
    ...citedEvidence,
    ...selectRelevantEvidence(query, evidence),
    ...evidence.filter(isUsableEvidence),
  ]).slice(0, LOW_CONFIDENCE_AVAILABLE_EVIDENCE_MAX_ITEMS);
}

function selectRelevantEvidence(
  query: string,
  evidence: readonly RecallEvidence[],
): RecallEvidence[] {
  const queryTerms = tokenizeValidationTerms(query);
  if (queryTerms.size === 0) {
    return [];
  }

  return evidence.filter(
    (item) =>
      isUsableEvidence(item) &&
      hasTermOverlap(queryTerms, tokenizeValidationTerms(evidenceText(item))),
  );
}

function isUsableEvidence(item: RecallEvidence): boolean {
  return item.excerpt.trim().length > 0 && item.metadata?.inspectError !== true;
}

function evidenceText(item: RecallEvidence): string {
  const metadataPath = item.metadata?.path;
  return [
    item.title,
    item.locator,
    item.excerpt,
    typeof metadataPath === "string" ? metadataPath : "",
  ].join("\n");
}

function hasTermOverlap(
  queryTerms: ReadonlySet<string>,
  evidenceTerms: ReadonlySet<string>,
): boolean {
  for (const term of queryTerms) {
    if (evidenceTerms.has(term)) {
      return true;
    }
  }
  return false;
}

function tokenizeValidationTerms(text: string): Set<string> {
  const terms = new Set<string>();
  for (const token of text.toLowerCase().match(/[a-z0-9_]+/g) ?? []) {
    if (token.length < 2 || NON_SALIENT_REFERENT_TERMS.has(token)) {
      continue;
    }
    terms.add(token);
    terms.add(stemValidationTerm(token));
  }
  return terms;
}

function stemValidationTerm(term: string): string {
  if (term.length > 4 && term.endsWith("ies")) {
    return `${term.slice(0, -3)}y`;
  }
  if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) {
    return term.slice(0, -1);
  }
  return term;
}

function formatAgenticRecallContent(options: {
  answer: string;
  availableEvidence: readonly RecallEvidence[];
  footer: string;
}): string {
  return [
    options.answer.trim(),
    formatAvailableEvidence(options.availableEvidence),
    options.footer,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function formatAvailableEvidence(evidence: readonly RecallEvidence[]): string {
  if (evidence.length === 0) {
    return "";
  }

  return [
    "Available evidence:",
    ...evidence.map((item, index) => {
      const excerpt = compactText(
        item.excerpt,
        AVAILABLE_EVIDENCE_EXCERPT_MAX_CHARS,
      );
      return `${index + 1}. [${item.source}] ${item.title} (${item.locator}): ${excerpt}`;
    }),
  ].join("\n");
}

function compactText(text: string, maxChars: number): string {
  const compacted = text.trim().replace(/\s+/g, " ");
  if (compacted.length <= maxChars) {
    return compacted;
  }
  if (maxChars <= 3) {
    return compacted.slice(0, maxChars);
  }
  return `${compacted.slice(0, maxChars - 3).trimEnd()}...`;
}

function dedupeEvidenceById(
  evidence: readonly RecallEvidence[],
): RecallEvidence[] {
  const seen = new Set<string>();
  const deduped: RecallEvidence[] = [];

  for (const item of evidence) {
    if (seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    deduped.push(item);
  }

  return deduped;
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
  const acceptedPaths: string[] = [];
  const rejectedPaths: string[] = [];
  for (const requestedPath of requestedPaths) {
    const acceptedPath = normalizeRequestedWorkspaceInspectionPath(
      requestedPath,
      allowedPaths,
    );
    if (acceptedPath) {
      acceptedPaths.push(acceptedPath);
    } else {
      rejectedPaths.push(requestedPath);
    }
  }

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
  if (!input.sources.includes("workspace") && !input.sources.includes("pkb")) {
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
    collectEvidenceWorkspacePaths(item).forEach((path) => paths.add(path));
  }
  return [...paths].filter(isSafeWorkspaceRelativePath).slice(0, 3);
}

function collectInspectableWorkspacePaths(
  query: string,
  evidence: readonly RecallEvidence[],
): Set<string> {
  const paths = new Set(extractWorkspacePathLiterals(query));
  for (const item of evidence) {
    collectEvidenceWorkspacePaths(item).forEach((path) => paths.add(path));
  }
  return paths;
}

function collectEvidenceWorkspacePaths(item: RecallEvidence): string[] {
  if (isAutoInjectedPkbContextEvidence(item)) {
    return [];
  }

  const rawPaths = new Set<string>();
  const metadataPath = item.metadata?.path;
  if (typeof metadataPath === "string") {
    rawPaths.add(metadataPath);
  }
  for (const text of [item.locator, item.title, item.excerpt]) {
    for (const path of extractWorkspacePathLiterals(text)) {
      rawPaths.add(path);
    }
  }

  const paths: string[] = [];
  for (const rawPath of rawPaths) {
    for (const path of normalizeEvidenceWorkspacePath(rawPath, item.source)) {
      if (isSafeWorkspaceRelativePath(path)) {
        paths.push(path);
      }
    }
  }
  return [...new Set(paths)];
}

function normalizeRequestedWorkspaceInspectionPath(
  requestedPath: string,
  allowedPaths: ReadonlySet<string>,
): string | null {
  const pkbPrefixedPath = `pkb/${requestedPath}`;
  if (!requestedPath.startsWith("pkb/") && allowedPaths.has(pkbPrefixedPath)) {
    return pkbPrefixedPath;
  }

  if (allowedPaths.has(requestedPath)) {
    return requestedPath;
  }

  return null;
}

function normalizeEvidenceWorkspacePath(
  path: string,
  source: RecallSource,
): string[] {
  if (path.startsWith("pkb/")) {
    return [path];
  }
  if (
    source === "pkb" ||
    PKB_RELATIVE_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))
  ) {
    return [`pkb/${path}`];
  }
  return [path];
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

  return demoteAutoInjectedContextEvidence(merged);
}

function demoteAutoInjectedContextEvidence(
  evidence: readonly RecallEvidence[],
): RecallEvidence[] {
  const regularEvidence: RecallEvidence[] = [];
  const autoInjectedContextEvidence: RecallEvidence[] = [];

  for (const item of evidence) {
    if (isAutoInjectedPkbContextEvidence(item)) {
      autoInjectedContextEvidence.push(item);
    } else {
      regularEvidence.push(item);
    }
  }

  return [...regularEvidence, ...autoInjectedContextEvidence];
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
  const orderedEvidence = demoteAutoInjectedContextEvidence(evidence);
  const evidenceCountBySource = new Map<RecallSource, number>();
  for (const item of orderedEvidence) {
    evidenceCountBySource.set(
      item.source,
      (evidenceCountBySource.get(item.source) ?? 0) + 1,
    );
  }

  return {
    ...result,
    evidence: orderedEvidence,
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
  const fallback = formatDeterministicRecallAnswer(result, {
    inspectCalls: debug.inspectCalls,
  });
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
