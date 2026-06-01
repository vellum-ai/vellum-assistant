import type {
  DeterministicRecallSearchResult,
  DeterministicRecallSourceNote,
} from "./search.js";
import type { RecallAnswer, RecallEvidence } from "./types.js";

const CITATION_EXCERPT_MAX_CHARS = 280;

export interface RecallFooterInspectCall {
  paths: readonly string[];
  errors?: readonly { path: string; reason: string }[];
}

export interface RecallFooterOptions {
  searchedSources: readonly DeterministicRecallSourceNote[];
  inspectCalls?: readonly RecallFooterInspectCall[];
}

export interface FormatDeterministicRecallAnswerOptions {
  inspectCalls?: readonly RecallFooterInspectCall[];
}

export function formatDeterministicRecallAnswer(
  result: DeterministicRecallSearchResult,
  options: FormatDeterministicRecallAnswerOptions = {},
): RecallAnswer {
  if (result.evidence.length === 0) {
    return {
      answer: [
        "No reliable results found.",
        formatRecallFooter({
          searchedSources: result.searchedSources,
          inspectCalls: options.inspectCalls,
        }),
      ]
        .filter(Boolean)
        .join("\n"),
      evidence: [],
    };
  }

  return {
    answer: [
      "Found evidence:",
      ...result.evidence.map(formatCitation),
      formatRecallFooter({
        searchedSources: result.searchedSources,
        inspectCalls: options.inspectCalls,
      }),
      formatRecallProvenanceTrailer(result.evidence),
    ]
      .filter(Boolean)
      .join("\n"),
    evidence: result.evidence,
  };
}

/**
 * Emits a small, machine-readable trailer marking recall output as stored
 * memory (not live state) and stamping the recency of the evidence behind it.
 * Consumers should treat recall as historical context and verify a resource's
 * current status before asserting it. Returns an empty string when there is no
 * evidence to stamp.
 */
export function formatRecallProvenanceTrailer(
  evidence: readonly RecallEvidence[],
): string {
  if (evidence.length === 0) {
    return "";
  }

  const latestTimestampMs = evidence.reduce<number | undefined>((max, item) => {
    if (typeof item.timestampMs !== "number") {
      return max;
    }
    return max === undefined || item.timestampMs > max ? item.timestampMs : max;
  }, undefined);

  const payload: {
    provenance: "stored_memory";
    mostRecentEvidenceAt?: string;
  } = { provenance: "stored_memory" };
  if (latestTimestampMs !== undefined) {
    payload.mostRecentEvidenceAt = formatEvidenceDate(latestTimestampMs);
  }

  return ["```json", JSON.stringify(payload), "```"].join("\n");
}

function formatEvidenceDate(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

export function formatRecallFooter(options: RecallFooterOptions): string {
  return [
    formatSearchedSources(options.searchedSources),
    formatDegradedSources(options.searchedSources),
    formatInspectedWorkspacePaths(options.inspectCalls ?? []),
    formatWorkspaceInspectionIssues(options.inspectCalls ?? []),
  ]
    .filter(Boolean)
    .join("\n");
}

function formatCitation(evidence: RecallEvidence, index: number): string {
  const excerpt = compactText(evidence.excerpt, CITATION_EXCERPT_MAX_CHARS);
  return `${index + 1}. [${evidence.source}] ${evidence.title} (${evidence.locator}): ${excerpt}`;
}

function formatSearchedSources(
  searchedSources: readonly DeterministicRecallSourceNote[],
): string {
  if (searchedSources.length === 0) {
    return "";
  }
  return `Searched sources: ${searchedSources
    .map((note) => note.source)
    .join(", ")}.`;
}

function formatDegradedSources(
  searchedSources: readonly DeterministicRecallSourceNote[],
): string {
  const degraded = searchedSources.filter((note) => note.status === "degraded");
  if (degraded.length === 0) {
    return "";
  }

  return `Degraded sources: ${degraded
    .map((note) =>
      note.error
        ? `${note.source} (${compactText(note.error, 120)})`
        : note.source,
    )
    .join(", ")}.`;
}

function formatInspectedWorkspacePaths(
  inspectCalls: readonly RecallFooterInspectCall[],
): string {
  const inspectedPaths = dedupeStrings(
    inspectCalls.flatMap((call) => {
      const errorPaths = new Set(
        (call.errors ?? []).map((error) => error.path),
      );
      return call.paths.filter((path) => !errorPaths.has(path));
    }),
  );
  if (inspectedPaths.length === 0) {
    return "";
  }

  return `Inspected workspace paths: ${inspectedPaths.join(", ")}.`;
}

function formatWorkspaceInspectionIssues(
  inspectCalls: readonly RecallFooterInspectCall[],
): string {
  const errors = dedupeStrings(
    inspectCalls.flatMap((call) =>
      (call.errors ?? []).map(
        (error) => `${error.path} (${compactText(error.reason, 120)})`,
      ),
    ),
  );
  if (errors.length === 0) {
    return "";
  }

  return `Workspace inspection issues: ${errors.join(", ")}.`;
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
