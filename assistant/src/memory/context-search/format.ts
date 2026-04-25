import type { DeterministicRecallSearchResult } from "./search.js";
import type { RecallAnswer, RecallEvidence } from "./types.js";

const CITATION_EXCERPT_MAX_CHARS = 280;

export function formatDeterministicRecallAnswer(
  result: DeterministicRecallSearchResult,
): RecallAnswer {
  if (result.evidence.length === 0) {
    return {
      answer: [
        "No reliable results found.",
        formatSearchedSources(result),
        formatDegradedSources(result),
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
      formatSearchedSources(result),
      formatDegradedSources(result),
    ]
      .filter(Boolean)
      .join("\n"),
    evidence: result.evidence,
  };
}

function formatCitation(evidence: RecallEvidence, index: number): string {
  const excerpt = compactText(evidence.excerpt, CITATION_EXCERPT_MAX_CHARS);
  return `${index + 1}. [${evidence.source}] ${evidence.title} (${evidence.locator}): ${excerpt}`;
}

function formatSearchedSources(
  result: DeterministicRecallSearchResult,
): string {
  if (result.searchedSources.length === 0) {
    return "";
  }
  return `Searched sources: ${result.searchedSources
    .map((note) => note.source)
    .join(", ")}.`;
}

function formatDegradedSources(
  result: DeterministicRecallSearchResult,
): string {
  const degraded = result.searchedSources.filter(
    (note) => note.status === "degraded",
  );
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
