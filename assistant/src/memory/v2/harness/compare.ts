/**
 * Run the comparison harness over a sample of historical turns.
 *
 * Ties the harness pieces together: pull oracle turns from telemetry, run each
 * retriever over each turn's reconstructed inputs, score against the logged
 * ground truth. Kept separate from the route handler so it can be unit-tested
 * with a stub retriever and a fixture DB — no live router / LLM.
 */

import type { AssistantConfig } from "../../../config/types.js";
import type { DrizzleDb } from "../../db-connection.js";
import { extractOracleTurns } from "./oracle.js";
import { reconstructInput } from "./replay-input.js";
import type { Retriever } from "./retriever.js";
import { type ComparisonReport, runComparison } from "./runner.js";

export interface RunComparisonOverHistoryParams {
  db: DrizzleDb;
  workspaceDir: string;
  config: AssistantConfig;
  retrievers: readonly Retriever[];
  ks: number[];
  limit?: number;
  strategy?: "recent" | "random";
  conversationIds?: string[];
  includeNotInjected?: boolean;
  pageExists?: (slug: string) => boolean;
  signal?: AbortSignal;
}

export async function runComparisonOverHistory(
  params: RunComparisonOverHistoryParams,
): Promise<ComparisonReport> {
  const { db, workspaceDir, config } = params;

  const oracleTurns = extractOracleTurns(db, {
    ...(params.limit !== undefined ? { limit: params.limit } : {}),
    ...(params.strategy !== undefined ? { strategy: params.strategy } : {}),
    ...(params.conversationIds !== undefined
      ? { conversationIds: params.conversationIds }
      : {}),
    ...(params.includeNotInjected !== undefined
      ? { includeNotInjected: params.includeNotInjected }
      : {}),
    ...(params.pageExists !== undefined
      ? { pageExists: params.pageExists }
      : {}),
  });

  return runComparison({
    retrievers: params.retrievers,
    oracleTurns,
    reconstruct: (turn) => reconstructInput(db, turn, config, workspaceDir),
    ks: params.ks,
    ...(params.signal !== undefined ? { signal: params.signal } : {}),
  });
}
