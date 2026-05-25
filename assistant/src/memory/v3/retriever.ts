/**
 * v3 retriever — the multi-lane bounded-descent retrieval loop
 * ({@link runRetrievalLoop}) adapted to the harness {@link Retriever}
 * interface.
 *
 * This is the offline, zero-production-risk shadow path: the comparison harness
 * replays historical oracle turns and scores v3's selection against the v2
 * router's logged picks (recall@k). Nothing here runs on a live injection turn
 * — the loop reads the DB handle for its hot lane but never mutates production
 * state, matching the {@link Retriever} contract.
 */

import type { DrizzleDb } from "../db-connection.js";
import type {
  RetrievalInput,
  RetrievalOutput,
  Retriever,
} from "../v2/harness/retriever.js";
import { runRetrievalLoop } from "./loop.js";

/**
 * Wrap the v3 retrieval loop as a named harness {@link Retriever}.
 *
 * @param db handle threaded to {@link runRetrievalLoop} for the scout hot lane.
 */
export function createV3Retriever(db: DrizzleDb): Retriever {
  return {
    name: "v3",
    retrieve(input: RetrievalInput): Promise<RetrievalOutput> {
      return runRetrievalLoop(input, { db });
    },
  };
}
