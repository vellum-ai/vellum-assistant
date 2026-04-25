import {
  ALL_RECALL_SOURCES,
  type NormalizedRecallInput,
  normalizeRecallInput,
  RECALL_EVIDENCE_TEXT_CAP_PER_SOURCE,
  RECALL_TOTAL_EVIDENCE_TEXT_CAP,
} from "./limits.js";
import type {
  RecallEvidence,
  RecallInput,
  RecallSearchContext,
  RecallSearchResult,
  RecallSource,
  RecallSourceAdapter,
} from "./types.js";

export type DeterministicRecallSourceStatus = "searched" | "degraded";

export interface DeterministicRecallSourceNote {
  source: RecallSource;
  status: DeterministicRecallSourceStatus;
  evidenceCount: number;
  error?: string;
}

export interface DeterministicRecallSearchResult extends RecallSearchResult {
  input: NormalizedRecallInput;
  searchedSources: DeterministicRecallSourceNote[];
}

export interface DeterministicRecallSearchOptions {
  adapters?: readonly RecallSourceAdapter[];
  readPkbContextEvidence?: (
    context: RecallSearchContext,
  ) => Promise<readonly RecallEvidence[]> | readonly RecallEvidence[];
}

const SOURCE_PRIORITY = new Map<RecallSource, number>(
  ALL_RECALL_SOURCES.map((source, index) => [source, index]),
);

const PINNED_PKB_CONTEXT_EVIDENCE_IDS = new Set([
  "pkb:auto-inject",
  "pkb:NOW.md",
]);

export async function runDeterministicRecallSearch(
  input: RecallInput,
  context: RecallSearchContext,
  options: DeterministicRecallSearchOptions = {},
): Promise<DeterministicRecallSearchResult> {
  const normalizedInput = normalizeRecallInput(input);
  const adapters =
    options.adapters ??
    (await loadDefaultRecallSourceAdapters(normalizedInput.sources));
  const adapterBySource = new Map<RecallSource, RecallSourceAdapter>(
    adapters.map((adapter) => [adapter.source, adapter]),
  );
  const evidenceBySource = new Map<RecallSource, RecallEvidence[]>(
    normalizedInput.sources.map((source) => [source, []]),
  );
  const errorsBySource = new Map<RecallSource, string>();

  if (normalizedInput.sources.includes("pkb")) {
    try {
      const contextEvidence = await readPkbContextEvidenceForSearch(
        context,
        options,
      );
      appendEvidence(evidenceBySource, "pkb", contextEvidence);
    } catch (err) {
      errorsBySource.set("pkb", errorToMessage(err));
    }
  }

  const selectedAdapters = normalizedInput.sources.flatMap((source) => {
    const adapter = adapterBySource.get(source);
    return adapter ? [adapter] : [];
  });
  const perAdapterLimit =
    normalizedInput.maxResults * normalizedInput.sourceRounds;
  const adapterResults = await Promise.allSettled(
    selectedAdapters.map((adapter) =>
      adapter.search(normalizedInput.query, context, perAdapterLimit),
    ),
  );

  adapterResults.forEach((settledResult, index) => {
    const source = selectedAdapters[index]?.source;
    if (!source) return;

    if (settledResult.status === "fulfilled") {
      appendEvidence(evidenceBySource, source, settledResult.value.evidence);
      return;
    }

    errorsBySource.set(source, errorToMessage(settledResult.reason));
  });

  const evidence = capEvidence(
    dedupeEvidence(sortEvidence([...evidenceBySource.values()].flat())),
    normalizedInput.maxResults,
  );

  const finalCountBySource = new Map<RecallSource, number>();
  for (const item of evidence) {
    finalCountBySource.set(
      item.source,
      (finalCountBySource.get(item.source) ?? 0) + 1,
    );
  }

  return {
    input: normalizedInput,
    evidence,
    searchedSources: normalizedInput.sources.map((source) => {
      const error = errorsBySource.get(source);
      return {
        source,
        status: error ? "degraded" : "searched",
        evidenceCount: finalCountBySource.get(source) ?? 0,
        ...(error ? { error } : {}),
      };
    }),
  };
}

async function loadDefaultRecallSourceAdapters(
  sources: readonly RecallSource[],
): Promise<readonly RecallSourceAdapter[]> {
  return Promise.all(sources.map(loadDefaultRecallSourceAdapter));
}

async function loadDefaultRecallSourceAdapter(
  source: RecallSource,
): Promise<RecallSourceAdapter> {
  switch (source) {
    case "memory": {
      const { searchMemorySource } = await import("./sources/memory.js");
      return { source, search: searchMemorySource };
    }
    case "pkb": {
      const { searchPkbSource } = await import("./sources/pkb.js");
      return { source, search: searchPkbSource };
    }
    case "conversations": {
      const { searchConversationSource } =
        await import("./sources/conversations.js");
      return { source, search: searchConversationSource };
    }
    case "workspace": {
      const { searchWorkspaceSource } = await import("./sources/workspace.js");
      return { source, search: searchWorkspaceSource };
    }
  }

  const exhaustiveSource: never = source;
  throw new Error(`Unknown recall source: ${String(exhaustiveSource)}`);
}

async function readPkbContextEvidenceForSearch(
  context: RecallSearchContext,
  options: DeterministicRecallSearchOptions,
): Promise<readonly RecallEvidence[]> {
  if (options.readPkbContextEvidence) {
    return options.readPkbContextEvidence(context);
  }

  const { readPkbContextEvidence } = await import("./sources/pkb.js");
  return readPkbContextEvidence(context);
}

function appendEvidence(
  evidenceBySource: Map<RecallSource, RecallEvidence[]>,
  source: RecallSource,
  evidence: readonly RecallEvidence[],
): void {
  const existing = evidenceBySource.get(source);
  if (existing) {
    existing.push(...evidence);
  } else {
    evidenceBySource.set(source, [...evidence]);
  }
}

function sortEvidence(evidence: RecallEvidence[]): RecallEvidence[] {
  return [...evidence].sort(compareEvidence);
}

function compareEvidence(a: RecallEvidence, b: RecallEvidence): number {
  const scoreCompare = (b.score ?? 0) - (a.score ?? 0);
  if (scoreCompare !== 0) return scoreCompare;

  const timestampCompare = (b.timestampMs ?? 0) - (a.timestampMs ?? 0);
  if (timestampCompare !== 0) return timestampCompare;

  const priorityCompare =
    (SOURCE_PRIORITY.get(a.source) ?? Number.MAX_SAFE_INTEGER) -
    (SOURCE_PRIORITY.get(b.source) ?? Number.MAX_SAFE_INTEGER);
  if (priorityCompare !== 0) return priorityCompare;

  return (
    [
      a.locator.localeCompare(b.locator),
      a.title.localeCompare(b.title),
      a.id.localeCompare(b.id),
      a.excerpt.localeCompare(b.excerpt),
    ].find((comparison) => comparison !== 0) ?? 0
  );
}

function dedupeEvidence(evidence: readonly RecallEvidence[]): RecallEvidence[] {
  const seen = new Set<string>();
  const deduped: RecallEvidence[] = [];

  for (const item of evidence) {
    const key = [
      item.source,
      item.locator,
      normalizeExcerptForDedupe(item.excerpt),
    ].join("\0");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }

  return deduped;
}

function normalizeExcerptForDedupe(excerpt: string): string {
  return excerpt.trim().replace(/\s+/g, " ").toLowerCase();
}

function capEvidence(
  evidence: readonly RecallEvidence[],
  maxResults: number,
): RecallEvidence[] {
  const pinnedEvidence = evidence.filter(isPinnedPkbContextEvidence);
  const regularEvidence = evidence.filter(
    (item) => !isPinnedPkbContextEvidence(item),
  );
  const capped: RecallEvidence[] = [];
  const textSizeBySource = new Map<RecallSource, number>();
  let totalTextSize = 0;

  for (let index = 0; index < pinnedEvidence.length; index += 1) {
    const item = pinnedEvidence[index];
    if (!item) continue;

    const pinnedRemaining = pinnedEvidence.length - index;
    const reservedTextBudget = getReservedPinnedTextBudget(item, {
      textSizeBySource,
      totalTextSize,
      pinnedRemaining,
    });
    const appended = appendCappedEvidence(item, {
      capped,
      textSizeBySource,
      totalTextSize,
      textBudget: reservedTextBudget,
    });
    totalTextSize = appended.totalTextSize;
    if (appended.totalRemaining <= 0) {
      return capped;
    }
  }

  const resultLimit = Math.max(maxResults, capped.length);
  for (const item of regularEvidence) {
    if (capped.length >= resultLimit) {
      break;
    }

    const appended = appendCappedEvidence(item, {
      capped,
      textSizeBySource,
      totalTextSize,
    });
    totalTextSize = appended.totalTextSize;
    if (appended.totalRemaining <= 0) break;
  }

  return capped;
}

function isPinnedPkbContextEvidence(item: RecallEvidence): boolean {
  return item.source === "pkb" && PINNED_PKB_CONTEXT_EVIDENCE_IDS.has(item.id);
}

function getReservedPinnedTextBudget(
  item: RecallEvidence,
  state: {
    textSizeBySource: Map<RecallSource, number>;
    totalTextSize: number;
    pinnedRemaining: number;
  },
): number {
  const sourceTextSize = state.textSizeBySource.get(item.source) ?? 0;
  const sourceRemaining = RECALL_EVIDENCE_TEXT_CAP_PER_SOURCE - sourceTextSize;
  const totalRemaining = RECALL_TOTAL_EVIDENCE_TEXT_CAP - state.totalTextSize;
  const remaining = Math.min(sourceRemaining, totalRemaining);
  return Math.max(1, Math.floor(remaining / state.pinnedRemaining));
}

function appendCappedEvidence(
  item: RecallEvidence,
  state: {
    capped: RecallEvidence[];
    textSizeBySource: Map<RecallSource, number>;
    totalTextSize: number;
    textBudget?: number;
  },
): { totalTextSize: number; totalRemaining: number } {
  const sourceTextSize = state.textSizeBySource.get(item.source) ?? 0;
  const sourceRemaining = RECALL_EVIDENCE_TEXT_CAP_PER_SOURCE - sourceTextSize;
  const totalRemaining = RECALL_TOTAL_EVIDENCE_TEXT_CAP - state.totalTextSize;
  const remaining = Math.min(
    sourceRemaining,
    totalRemaining,
    state.textBudget ?? Number.MAX_SAFE_INTEGER,
  );
  if (remaining <= 0) {
    return { totalTextSize: state.totalTextSize, totalRemaining };
  }

  const excerpt = truncateText(item.excerpt, remaining);
  if (excerpt.length === 0) {
    return { totalTextSize: state.totalTextSize, totalRemaining };
  }

  state.capped.push(excerpt === item.excerpt ? item : { ...item, excerpt });
  state.textSizeBySource.set(item.source, sourceTextSize + excerpt.length);
  const totalTextSize = state.totalTextSize + excerpt.length;

  return {
    totalTextSize,
    totalRemaining: RECALL_TOTAL_EVIDENCE_TEXT_CAP - totalTextSize,
  };
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= 3) {
    return text.slice(0, maxChars);
  }
  return `${text.slice(0, maxChars - 3).trimEnd()}...`;
}

function errorToMessage(err: unknown): string {
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return String(err);
}
