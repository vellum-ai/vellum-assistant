/**
 * Structured result types for the simplified memory reducer.
 *
 * The reducer processes conversation turns and produces CRUD operations for
 * two brief-state tables (time_contexts, open_loops) and optional archive
 * candidates (observations, episodes).
 *
 * These types are consumed by the reducer parser/validator and eventually by
 * the DB-write layer that applies them atomically.
 */

// ── Time-context CRUD ──────────────────────────────────────────────────

export interface TimeContextCreate {
  action: "create";
  summary: string;
  source: string;
  activeFrom: number; // epoch ms
  activeUntil: number; // epoch ms
}

export interface TimeContextUpdate {
  action: "update";
  id: string;
  summary?: string;
  activeFrom?: number;
  activeUntil?: number;
}

export interface TimeContextResolve {
  action: "resolve";
  id: string;
}

export type TimeContextOp =
  | TimeContextCreate
  | TimeContextUpdate
  | TimeContextResolve;

// ── Open-loop CRUD ─────────────────────────────────────────────────────

export interface OpenLoopCreate {
  action: "create";
  summary: string;
  source: string;
  dueAt?: number; // epoch ms, optional deadline
}

export interface OpenLoopUpdate {
  action: "update";
  id: string;
  summary?: string;
  dueAt?: number;
}

export interface OpenLoopResolve {
  action: "resolve";
  id: string;
  status: "resolved" | "expired";
}

export type OpenLoopOp = OpenLoopCreate | OpenLoopUpdate | OpenLoopResolve;

// ── Archive candidates ─────────────────────────────────────────────────

export interface ArchiveObservationCandidate {
  content: string;
  role: string;
  modality?: string;
  source?: string;
}

export interface ArchiveEpisodeCandidate {
  title: string;
  summary: string;
  source?: string;
}

// ── Top-level reducer result ───────────────────────────────────────────

export interface ReducerResult {
  timeContexts: TimeContextOp[];
  openLoops: OpenLoopOp[];
  archiveObservations: ArchiveObservationCandidate[];
  archiveEpisodes: ArchiveEpisodeCandidate[];
}

/**
 * Sentinel empty result returned when the reducer output is **unparseable**
 * (not valid JSON, not a JSON object, provider failure, etc.).
 *
 * Callers use identity comparison (`=== EMPTY_REDUCER_RESULT`) to detect
 * true parse failures and skip checkpoint advancement so the job can retry.
 *
 * A valid-but-empty model response (e.g. `{}`) returns a normal
 * `ReducerResult` with all empty arrays — NOT this sentinel — so the
 * checkpoint advances and the dirty tail is cleared.
 */
export const EMPTY_REDUCER_RESULT: Readonly<ReducerResult> = Object.freeze({
  timeContexts: Object.freeze([]) as unknown as TimeContextOp[],
  openLoops: Object.freeze([]) as unknown as OpenLoopOp[],
  archiveObservations: Object.freeze(
    [],
  ) as unknown as ArchiveObservationCandidate[],
  archiveEpisodes: Object.freeze([]) as unknown as ArchiveEpisodeCandidate[],
});
