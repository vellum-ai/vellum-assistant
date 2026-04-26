import { truncate } from "../../util/truncate.js";
import { ALL_RECALL_SOURCES, normalizeRecallSources } from "./limits.js";
import type { RecallEvidence, RecallSource } from "./types.js";

export type RecallAgentConfidence = "high" | "medium" | "low";

export interface RecallAgentToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface RecallAgentPromptOptions {
  query: string;
  availableSources?: readonly RecallSource[];
  evidence: readonly RecallEvidence[];
  evidenceBudgetChars?: number;
  maxSearchCalls?: number;
}

export interface RecallAgentPromptBundle {
  prompt: string;
  evidence: RecallEvidence[];
}

export interface RecallAgentFinish {
  answer: string;
  confidence: RecallAgentConfidence;
  citationIds: string[];
  unresolved?: string[];
}

export type RecallFinishFallbackReason =
  | "malformed_finish_payload"
  | "invalid_confidence"
  | "invalid_citation_ids"
  | "unknown_citation_ids"
  | "empty_answer";

export type RecallFinishValidationResult =
  | { ok: true; finish: RecallAgentFinish }
  | {
      ok: false;
      reason: RecallFinishFallbackReason;
      finish: RecallAgentFinish;
      missingCitationIds?: string[];
    };

export interface RecallCitationValidationResult {
  ok: boolean;
  validCitationIds: string[];
  missingCitationIds: string[];
}

const DEFAULT_RECALL_AGENT_EVIDENCE_BUDGET_CHARS = 12_000;
const DEFAULT_MAX_SEARCH_CALLS = 4;

const RECALL_SOURCE_DESCRIPTIONS: Record<RecallSource, string> = {
  memory: "durable memory graph facts and relationship/context memories",
  pkb: "personal knowledge base notes, NOW context, and pinned context",
  conversations: "past assistant conversations and conversation summaries",
  workspace: "files and text available in the current workspace",
};

export const SEARCH_SOURCES_TOOL_DEFINITION: RecallAgentToolDefinition = {
  name: "search_sources",
  description:
    "Search bounded internal recall sources for evidence relevant to the user's query.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Focused search query for the evidence to retrieve.",
      },
      sources: {
        type: "array",
        description: "Optional subset of internal sources to search.",
        items: { type: "string", enum: [...ALL_RECALL_SOURCES] },
        uniqueItems: true,
      },
      limit: {
        type: "integer",
        description: "Optional maximum number of evidence items to return.",
        minimum: 1,
        maximum: 20,
      },
      reason: {
        type: "string",
        description:
          "Brief reason this search is needed and what uncertainty it should resolve.",
      },
    },
    required: ["query", "reason"],
    additionalProperties: false,
  },
};

export const INSPECT_WORKSPACE_PATHS_TOOL_DEFINITION: RecallAgentToolDefinition =
  {
    name: "inspect_workspace_paths",
    description:
      "Inspect exact safe workspace-relative files that were surfaced by the query or prior evidence.",
    input_schema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          description:
            "Safe relative workspace file paths to inspect, such as scratch/handoff.md.",
          items: { type: "string" },
          minItems: 1,
          maxItems: 5,
          uniqueItems: true,
        },
        reason: {
          type: "string",
          description:
            "Brief reason these exact paths need inspection before answering.",
        },
      },
      required: ["paths", "reason"],
      additionalProperties: false,
    },
  };

export const FINISH_RECALL_TOOL_DEFINITION: RecallAgentToolDefinition = {
  name: "finish_recall",
  description:
    "Return the final recall answer with confidence and exact evidence citations.",
  input_schema: {
    type: "object",
    properties: {
      answer: {
        type: "string",
        description:
          "Final answer. Report uncertainty or conflicts instead of guessing.",
      },
      confidence: {
        type: "string",
        enum: ["high", "medium", "low"],
      },
      citation_ids: {
        type: "array",
        description:
          "Evidence ids that directly support the answer. Use only ids supplied by the engine.",
        items: { type: "string" },
      },
      unresolved: {
        type: "array",
        description:
          "Optional unresolved questions, missing evidence, or conflicts.",
        items: { type: "string" },
      },
    },
    required: ["answer", "confidence", "citation_ids"],
    additionalProperties: false,
  },
};

export const RECALL_AGENT_TOOL_DEFINITIONS: readonly RecallAgentToolDefinition[] =
  [
    SEARCH_SOURCES_TOOL_DEFINITION,
    INSPECT_WORKSPACE_PATHS_TOOL_DEFINITION,
    FINISH_RECALL_TOOL_DEFINITION,
  ] as const;

export function buildRecallAgentPrompt(
  options: RecallAgentPromptOptions,
): string {
  return buildRecallAgentPromptBundle(options).prompt;
}

export function buildRecallAgentPromptBundle(
  options: RecallAgentPromptOptions,
): RecallAgentPromptBundle {
  const availableSources = normalizeRecallSources(options.availableSources);
  const maxSearchCalls = options.maxSearchCalls ?? DEFAULT_MAX_SEARCH_CALLS;
  const evidence = prepareRecallAgentPromptEvidence(
    options.evidence,
    options.evidenceBudgetChars,
  );
  const citationIds = evidence.map((item) => item.id);

  const prompt = [
    "You are the bounded internal recall agent. Find reliable information for the user's recall request using only the internal sources and evidence supplied by the engine.",
    "",
    `User query: ${options.query}`,
    "",
    "Available internal sources:",
    ...availableSources.map(
      (source) => `- ${source}: ${RECALL_SOURCE_DESCRIPTIONS[source]}`,
    ),
    "",
    "Rules:",
    "- Use search_sources when more evidence is needed. Keep searches focused and explain the reason.",
    `- Do not make more than ${maxSearchCalls} search_sources calls unless the engine gives you a new budget.`,
    "- Use inspect_workspace_paths when the user query or evidence points at a concrete workspace file. Inspect the file before saying the answer is missing.",
    "- inspect_workspace_paths only accepts safe relative paths that appeared in the query or evidence; if inspection fails, report that uncertainty instead of guessing.",
    "- For indirect references (for example, 'the cake Bob asked about'), first find the referring exchange, then search likely candidate referents named or implied by that evidence before finishing.",
    "- If evidence says a referent is unresolved but gives candidate events, objects, or adjacent facts, search those candidates and report the caveat instead of stopping at 'unresolved'.",
    "- Treat requested output fields like flavor, decoration, message, recipient, timing, or plan details as things to answer, not mandatory search terms.",
    "- Do not use external web, internet, browser, or network sources.",
    "- Do not guess. If the evidence is missing, weak, or contradictory, say so.",
    "- Do not say the information is absent while any supplied evidence contains relevant facts; cite and summarize the partial evidence instead.",
    "- Report conflicts in the answer or unresolved field instead of silently choosing one side.",
    "- Cite supporting evidence with exact citation_ids from the evidence table only.",
    "- The final output must be a finish_recall tool call.",
    "",
    formatAllowedCitationIds(citationIds),
    "",
    "Evidence table:",
    formatRecallEvidenceTable(evidence),
  ].join("\n");

  return { prompt, evidence };
}

function prepareRecallAgentPromptEvidence(
  evidence: readonly RecallEvidence[],
  evidenceBudgetChars = DEFAULT_RECALL_AGENT_EVIDENCE_BUDGET_CHARS,
): RecallEvidence[] {
  return truncateRecallEvidenceToBudget(evidence, evidenceBudgetChars);
}

export function truncateRecallEvidenceToBudget(
  evidence: readonly RecallEvidence[],
  maxTextChars: number,
): RecallEvidence[] {
  if (!Number.isFinite(maxTextChars) || maxTextChars <= 0) {
    return [];
  }

  const truncated: RecallEvidence[] = [];
  let remaining = Math.floor(maxTextChars);

  for (const item of evidence) {
    if (remaining <= 0) break;

    const excerpt = truncate(item.excerpt, remaining);
    if (excerpt.length === 0) {
      continue;
    }

    truncated.push(excerpt === item.excerpt ? item : { ...item, excerpt });
    remaining -= excerpt.length;
  }

  return truncated;
}

export function validateRecallCitationIds(
  citationIds: readonly string[],
  evidence: readonly RecallEvidence[],
): RecallCitationValidationResult {
  const allowedIds = new Set(evidence.map((item) => item.id));
  const validCitationIds: string[] = [];
  const missingCitationIds: string[] = [];

  for (const citationId of dedupeStrings(citationIds)) {
    if (allowedIds.has(citationId)) {
      validCitationIds.push(citationId);
    } else {
      missingCitationIds.push(citationId);
    }
  }

  return {
    ok: missingCitationIds.length === 0,
    validCitationIds,
    missingCitationIds,
  };
}

export function validateFinishRecallPayload(
  payload: unknown,
  evidence: readonly RecallEvidence[],
): RecallFinishValidationResult {
  if (!isRecord(payload)) {
    return fallbackFinish("malformed_finish_payload");
  }

  const answer = readNonEmptyString(payload.answer);
  if (!answer) {
    return fallbackFinish("empty_answer");
  }

  if (!isRecallAgentConfidence(payload.confidence)) {
    return fallbackFinish("invalid_confidence");
  }

  if (!isStringArray(payload.citation_ids)) {
    return fallbackFinish("invalid_citation_ids");
  }

  const citationValidation = validateRecallCitationIds(
    payload.citation_ids,
    evidence,
  );
  if (!citationValidation.ok) {
    return {
      ...fallbackFinish("unknown_citation_ids", [
        `Unknown citation ids: ${citationValidation.missingCitationIds.join(
          ", ",
        )}`,
      ]),
      missingCitationIds: citationValidation.missingCitationIds,
    };
  }

  const unresolved = readOptionalStringArray(payload.unresolved);
  if (unresolved === null) {
    return fallbackFinish("malformed_finish_payload");
  }

  return {
    ok: true,
    finish: {
      answer,
      confidence: payload.confidence,
      citationIds: citationValidation.validCitationIds,
      ...(unresolved.length > 0 ? { unresolved } : {}),
    },
  };
}

function formatAllowedCitationIds(citationIds: readonly string[]): string {
  if (citationIds.length === 0) {
    return "Allowed citation_ids: none yet. Search for evidence before citing.";
  }

  return `Allowed citation_ids: ${citationIds.join(", ")}`;
}

function formatRecallEvidenceTable(
  evidence: readonly RecallEvidence[],
): string {
  if (evidence.length === 0) {
    return "No evidence supplied yet.";
  }

  return evidence.map(formatEvidenceRow).join("\n");
}

function formatEvidenceRow(item: RecallEvidence): string {
  return [
    `- id: ${item.id}`,
    `  source: ${item.source}`,
    `  title: ${item.title}`,
    `  locator: ${item.locator}`,
    `  text: ${compactWhitespace(item.excerpt)}`,
  ].join("\n");
}

function fallbackFinish(
  reason: RecallFinishFallbackReason,
  unresolved: string[] = [`Recall agent returned ${reason}.`],
): RecallFinishValidationResult & { ok: false } {
  return {
    ok: false,
    reason,
    finish: {
      answer: "No reliable answer could be produced by the recall agent.",
      confidence: "low",
      citationIds: [],
      unresolved,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecallAgentConfidence(
  value: unknown,
): value is RecallAgentConfidence {
  return value === "high" || value === "medium" || value === "low";
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function readOptionalStringArray(value: unknown): string[] | null {
  if (value === undefined) {
    return [];
  }
  if (!isStringArray(value)) {
    return null;
  }

  return dedupeStrings(value.map((item) => item.trim()).filter(Boolean));
}

function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    deduped.push(value);
  }

  return deduped;
}

function compactWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}
