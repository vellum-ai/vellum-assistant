import { describe, expect, test } from "bun:test";

import {
  formatDeterministicRecallAnswer,
  formatRecallProvenanceTrailer,
} from "../memory/context-search/format.js";
import type { DeterministicRecallSearchResult } from "../memory/context-search/search.js";
import type { RecallEvidence } from "../memory/context-search/types.js";

function evidence(overrides: Partial<RecallEvidence> = {}): RecallEvidence {
  return {
    id: overrides.id ?? "memory:node-1",
    source: overrides.source ?? "memory",
    title: overrides.title ?? "Note",
    locator: overrides.locator ?? "node-1",
    excerpt: overrides.excerpt ?? "some recalled content",
    ...overrides,
  };
}

// 2026-05-25T16:12:00Z and 2026-05-28T09:00:00Z
const MAY_25 = Date.UTC(2026, 4, 25, 16, 12, 0);
const MAY_28 = Date.UTC(2026, 4, 28, 9, 0, 0);

describe("formatRecallProvenanceTrailer", () => {
  test("returns an empty string when there is no evidence to stamp", () => {
    // GIVEN no evidence
    // WHEN building the provenance trailer
    const trailer = formatRecallProvenanceTrailer([]);

    // THEN nothing is emitted
    expect(trailer).toBe("");
  });

  test("stamps stored-memory provenance and the most recent evidence date", () => {
    // GIVEN evidence recorded on two different days
    const items = [
      evidence({ id: "memory:a", timestampMs: MAY_25 }),
      evidence({
        id: "conversations:b",
        source: "conversations",
        timestampMs: MAY_28,
      }),
    ];

    // WHEN building the provenance trailer
    const trailer = formatRecallProvenanceTrailer(items);

    // THEN it is a fenced JSON block flagging stored memory and the newest date
    expect(trailer).toBe(
      [
        "```json",
        '{"provenance":"stored_memory","mostRecentEvidenceAt":"2026-05-28"}',
        "```",
      ].join("\n"),
    );
  });

  test("omits the date when no evidence carries a timestamp", () => {
    // GIVEN workspace evidence with no intrinsic timestamp
    const items = [evidence({ id: "workspace:x", source: "workspace" })];

    // WHEN building the provenance trailer
    const trailer = formatRecallProvenanceTrailer(items);

    // THEN provenance is still emitted but no recency date is asserted
    expect(trailer).toBe(
      ["```json", '{"provenance":"stored_memory"}', "```"].join("\n"),
    );
  });
});

describe("formatDeterministicRecallAnswer provenance trailer", () => {
  function searchResult(
    items: RecallEvidence[],
  ): DeterministicRecallSearchResult {
    return {
      evidence: items,
      input: {
        query: "why was my watcher disabled",
        sources: ["memory", "conversations", "workspace"],
        maxResults: 10,
        depth: "standard",
        sourceRounds: 2,
      },
      searchedSources: [
        { source: "memory", status: "searched", evidenceCount: items.length },
      ],
    };
  }

  test("appends the provenance trailer when evidence is present", () => {
    // GIVEN a deterministic recall result with dated evidence
    const result = searchResult([
      evidence({ id: "memory:a", timestampMs: MAY_25 }),
    ]);

    // WHEN formatting the answer shown to the model
    const { answer } = formatDeterministicRecallAnswer(result);

    // THEN the answer ends with the machine-readable provenance/recency trailer
    expect(answer).toContain("Found evidence:");
    expect(answer).toContain(
      '{"provenance":"stored_memory","mostRecentEvidenceAt":"2026-05-25"}',
    );
  });

  test("does not append a trailer when there is no evidence", () => {
    // GIVEN a deterministic recall result with no evidence
    const result = searchResult([]);

    // WHEN formatting the answer shown to the model
    const { answer } = formatDeterministicRecallAnswer(result);

    // THEN the no-results answer carries no provenance trailer
    expect(answer).toContain("No reliable results found.");
    expect(answer).not.toContain("provenance");
  });
});
