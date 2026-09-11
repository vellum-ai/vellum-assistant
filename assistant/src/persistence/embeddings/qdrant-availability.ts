/**
 * Whether the local Qdrant vector store came up on this daemon.
 *
 * Read sites that have no fallback need to distinguish "the index answered and
 * matched nothing" from "there is no index to ask". Message-content search is
 * the sharp case: migration `313-drop-messages-fts.ts` dropped the `messages_fts`
 * table, so `messages_lexical` is the only source of content matches. When Qdrant
 * is not running, `searchConversations` degrades to matching conversation titles
 * and returns a short list that is indistinguishable from "nothing matched".
 *
 * Deliberately NOT the Qdrant circuit breaker
 * (`qdrant-circuit-breaker.ts`). That breaker answers a different question:
 * whether recent operations failed often enough to fail fast. It reads closed
 * before the first call, so on a daemon whose Qdrant never started it reports
 * healthy right up until a read fails, which is exactly the window this fact
 * covers. The breaker also gates the v1 collection, so forcing it open here
 * would change v1 read behaviour well beyond this concern.
 *
 * Set once by the memory plugin's startup after the Qdrant start attempts
 * settle, so it only carries a verdict in the daemon process (the memory worker
 * runs its own process and never calls `runMemoryStartup`; see
 * `job-handlers/message-lexical.ts`). Until PR 2 adds a supervisor there is no
 * path that restarts Qdrant mid-process, so a start failure is terminal for the
 * daemon's lifetime and this fact does not need to change back.
 *
 * Defaults to available so a daemon that never reaches the memory startup path
 * behaves exactly as it did before this fact existed. On that daemon the
 * backfill sentinel is unset anyway, which is what actually gates the read.
 */

/** Why the vector store is not a usable read source. */
export type QdrantUnavailableReason = "start_failed";

interface QdrantAvailability {
  available: boolean;
  reason?: QdrantUnavailableReason;
}

let state: QdrantAvailability = { available: true };

/** Record that the local Qdrant store is up and serving. */
export function markQdrantAvailable(): void {
  state = { available: true };
}

/** Record that the local Qdrant store is not usable, with the reason why. */
export function markQdrantUnavailable(reason: QdrantUnavailableReason): void {
  state = { available: false, reason };
}

/** The current verdict, for read sites deciding whether to trust the index. */
export function getQdrantAvailability(): Readonly<QdrantAvailability> {
  return state;
}

/** @internal Test-only: restore the default (available) verdict. */
export function _resetQdrantAvailability(): void {
  state = { available: true };
}
