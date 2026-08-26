import { createHash } from "node:crypto";

import { isNotNull } from "drizzle-orm";

import { SYNC_TAGS } from "../daemon/message-types/sync.js";
import { getDb } from "../persistence/db-connection.js";
import { acpSessionHistory } from "../persistence/schema/index.js";
import { getLogger } from "../util/logger.js";
import { takeConversationsWithAcpConnectCard } from "./acp-connect-card-state.js";

const log = getLogger("acp-auth-marker-store");

/**
 * Clear the credential-failure marker from every ACP history row.
 *
 * Called when a replacement Claude token is stored, which is the one moment
 * it is known that the failures these markers describe are repaired. Nothing
 * else can tell: the connected check answers on whether a token is present,
 * not on whether Claude accepts it, so a client holding a restored card
 * cannot retire it on its own.
 *
 * Every row rather than a tracked subset. The alternative is the process-local
 * set of conversations that raised a card, which a daemon restart empties
 * while the persisted markers survive, stranding them forever. The write
 * touches only rows that carry a marker, and a workspace holds few of them.
 *
 * Never throws: the token is stored either way, and a stale marker costs a
 * card offering to connect something already connected.
 */
export function clearAcpAuthMarkers(): void {
  try {
    getDb()
      .update(acpSessionHistory)
      .set({ authErrorCode: null })
      .where(isNotNull(acpSessionHistory.authErrorCode))
      .run();
  } catch (err) {
    log.error(
      { err },
      "clearing ACP auth markers failed; a stale Connect card may reappear",
    );
  }
}

/**
 * Bumped every time a Claude token is written, so a caller that read the
 * credential earlier can tell whether it is still the current one.
 *
 * A run that started under an older generation and only now reports its
 * credential rejected is describing a token that has since been replaced.
 * Raising recovery for it would offer a Connect card for auth that already
 * works, after the sweep that would have retired it has run.
 *
 * In-memory, which is the right lifetime: sessions do not outlive the process
 * either, so a restart leaves no run holding a stale generation.
 */
let claudeCredentialGeneration = 0;

/** Current generation of the stored Claude credential. */
export function currentClaudeCredentialGeneration(): number {
  return claudeCredentialGeneration;
}

/**
 * Digest of the Claude token believed to be in secure storage, or `undefined`
 * before any write in this process has told us.
 *
 * Identity rather than a version counter. A counter only answers "is this the
 * token stored now" by proxy, and that proxy needs the read and the write
 * serialized to stay true: publish the token before bumping and a read landing
 * in between captures the new token under the old number, which then reads as
 * superseded and suppresses a real rejection. Comparing the token itself has
 * no such window, because the answer travels with the thing it describes.
 */
let storedClaudeTokenDigest: string | undefined;

/** Digest a Claude token for identity comparison. Never stores the token. */
export function claudeTokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 32);
}

/**
 * Record the token now believed to be stored, returning the previous value so
 * a failed write can put it back.
 *
 * Set *before* the backing write, so a read landing between the two compares
 * against the token it will actually get. A write that then fails restores the
 * previous digest rather than leaving the cache describing a token that was
 * never published.
 */
export function setStoredClaudeTokenDigest(
  digest: string | undefined,
): string | undefined {
  const previous = storedClaudeTokenDigest;
  storedClaudeTokenDigest = digest;
  return previous;
}

/**
 * Whether a run holding `digest` is still holding the stored credential.
 *
 * Unknown answers `true`: nothing in this process has written a token, so
 * there is no evidence the run's was replaced, and this path must fail toward
 * leaving the user a route back to auth rather than suppressing one.
 */
export function claudeCredentialStillCurrent(
  digest: string | undefined,
): boolean {
  if (digest === undefined || storedClaudeTokenDigest === undefined) {
    return true;
  }
  return digest === storedClaudeTokenDigest;
}

/**
 * Retire everything a past Claude auth failure left behind, because a new
 * token has just been written.
 *
 * Called from `setSecureKeyAsync`, the seam every writer of that vault field
 * converges on, rather than from the writers themselves. A token repaired
 * through any of them repairs the ACP runs equally, and hanging this off the
 * seam is what keeps the behaviour from depending on a list of callers that
 * drifts as new write paths appear.
 *
 * The generation bump comes first, so a rejection racing this write sees the
 * newer generation and declines to re-mark rather than landing after the
 * sweep.
 */
export function retireAcpAuthRecovery(): void {
  claudeCredentialGeneration += 1;
  clearAcpAuthMarkers();
  takeConversationsWithAcpConnectCard();
  // Other clients cannot discover this on their own: a restored
  // `auth_required` prompt deliberately skips the connected-state self-heal,
  // and nothing refetches the ACP snapshot until navigation or reconnect, so
  // they would keep offering Connect for the token just replaced. Published
  // after the writes above so a client that refetches on the invalidation sees
  // the cleared state. Imported on demand to keep the event hub out of this
  // module's load path, and never awaited: the retirement is already done, and
  // a broadcast failure must not fail the token write that triggered it.
  void import("../runtime/sync/sync-publisher.js")
    .then(({ publishSyncInvalidation }) =>
      publishSyncInvalidation([SYNC_TAGS.acpAuthRecovery]),
    )
    .catch((err: unknown) => {
      log.warn({ err }, "failed to publish ACP auth recovery invalidation");
    });
}

/**
 * Generation current when each rejected config-supplied Claude token was
 * refused, keyed by a digest of the token itself.
 *
 * `acp.agents.<id>.env.CLAUDE_CODE_OAUTH_TOKEN` takes precedence over the
 * vault, so a revoked value there is not something Connect can fix by writing
 * secure storage: the next spawn resolves the same configured token and raises
 * the card again. Remembering which token was rejected, and when, lets a later
 * read stand down exactly that value.
 *
 * Keyed by token rather than held as one process-global flag: several agent
 * aliases can each carry their own configured token, and a global one-shot is
 * consumed by whichever alias prepares first, which both discards that alias's
 * perfectly good token and leaves the rejected one trusted again.
 *
 * A digest, not the token: this outlives the spawn that produced it, and a
 * rejected credential is still a credential.
 */
const rejectedConfigTokens = new Map<string, number>();

const configTokenDigest = claudeTokenDigest;

/**
 * Record that this configured Claude token was the one Claude rejected.
 *
 * `generationAtInjection` is the generation current when the run took the
 * value, not when it failed. A token write landing between those two moments
 * would otherwise be recorded as the rejection's own generation, leaving
 * `configClaudeTokenSuperseded` comparing a number against itself and
 * reporting the revoked value as still trustworthy.
 */
export function noteConfigClaudeTokenRejected(
  token: string,
  generationAtInjection: number,
): void {
  rejectedConfigTokens.set(configTokenDigest(token), generationAtInjection);
}

/**
 * Whether this configured Claude token should stand down in favour of the
 * vault.
 *
 * True once a token has been written after this one was rejected: that write
 * is the user completing Connect, and honouring the config value over it would
 * loop the card forever.
 *
 * The record is kept, not consumed. A revoked value the user never removes
 * from config is resolved by every later spawn too, so a one-shot only spares
 * the first one and lets the next reopen the loop. Keying by digest is what
 * makes retention safe: a config value the user actually fixes hashes
 * differently and was never recorded, so it is trusted on sight.
 */
export function configClaudeTokenSuperseded(token: string): boolean {
  const rejectedAt = rejectedConfigTokens.get(configTokenDigest(token));
  return rejectedAt !== undefined && claudeCredentialGeneration > rejectedAt;
}
