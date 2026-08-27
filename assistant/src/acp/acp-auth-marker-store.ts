import { createHash } from "node:crypto";

import { and, desc, eq, isNotNull } from "drizzle-orm";

import { getDb } from "../persistence/db-connection.js";
import {
  acpRefusedCredentials,
  acpSessionHistory,
} from "../persistence/schema/index.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("acp-auth-marker-store");

/**
 * How many of a conversation's newest markers are examined before giving up on
 * finding a current one.
 *
 * A conversation keeps every marker it has ever had, so this bounds the read
 * to a fixed cost. Beyond the newest few the answer is nearly always the same,
 * and erring toward "no current marker" only forgets bookkeeping that the next
 * failure recreates.
 */
export const MARKER_SCAN_LIMIT = 20;

/** Digest a Claude token for identity comparison. Never stores the token. */
export function claudeTokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 32);
}

/**
 * Whether a credential-failure marker is still worth showing a card for.
 *
 * The marker names the credential the run was refused on. It stops being worth
 * showing the moment a spawn would resolve a different one, because that is
 * the user having repaired the auth the card exists to send them to.
 *
 * Answered by comparing, not by remembering. Nothing has to run at the right
 * moment for a repaired marker to stop rendering, which is the difference
 * between this and a retirement sweep: a sweep has to be ordered against every
 * in-flight write and in-flight read, and a daemon restart loses whatever it
 * was tracking. A comparison has no ordering to get wrong and no lifetime.
 *
 * Fails toward showing the card. A marker with no credential named predates
 * this column or was written by a path that had none, and an unknown
 * credential is no evidence the failure was repaired.
 */
export function acpAuthMarkerStillCurrent(
  markerCredential: string | null | undefined,
  resolvedCredential: string | undefined,
): boolean {
  if (markerCredential == null || resolvedCredential === undefined) {
    return true;
  }
  return markerCredential === resolvedCredential;
}

/**
 * Record that Claude refused this token, so no later spawn resolves it again.
 *
 * Kept in its own table rather than read back off the marker rows. A marker is
 * about showing a card for one run and the user may delete it with that run,
 * while this decides which credential a spawn selects, and clearing session
 * history must not change that. A configured
 * `acp.agents.<id>.env.CLAUDE_CODE_OAUTH_TOKEN` lives in config, so forgetting
 * a refusal lets the revoked value win over the vault replacement again.
 *
 * Never throws: a run has already failed by the time this is called, and
 * losing the record costs one more failed spawn rather than the failure
 * handling itself.
 */
export function noteClaudeTokenRefused(
  digest: string | undefined,
  refusedAt: number,
): void {
  if (digest === undefined) {
    return;
  }
  try {
    getDb()
      .insert(acpRefusedCredentials)
      .values({ digest, refusedAt })
      .onConflictDoNothing()
      .run();
  } catch (err) {
    log.error(
      { err },
      "recording a refused Claude credential failed; it may be resolved again",
    );
  }
}

/**
 * Whether Claude has refused this token before.
 *
 * Never throws: this only narrows which token a spawn prefers, and a read
 * failure must not take the spawn with it. Failing open resolves the
 * configured token, which is what would have happened before it was ever
 * refused.
 */
export function claudeTokenRefusedByClaude(token: string): boolean {
  return claudeCredentialRefused(claudeTokenDigest(token));
}

/**
 * Whether Claude has refused the credential with this digest.
 *
 * The same question as {@link claudeTokenRefusedByClaude}, for callers that
 * hold an identity rather than the token itself: a resolver reports which
 * credential a spawn would pick, and "would pick it" is not the same as
 * "it works".
 */
export function claudeCredentialRefused(digest: string): boolean {
  try {
    const row = getDb()
      .select({ digest: acpRefusedCredentials.digest })
      .from(acpRefusedCredentials)
      .where(eq(acpRefusedCredentials.digest, digest))
      .limit(1)
      .get();
    return row !== undefined;
  } catch (err) {
    log.error(
      { err },
      "reading refused Claude credentials failed; treating the token as untried",
    );
    return false;
  }
}

/**
 * Whether this conversation still has a credential failure worth showing a
 * card for.
 *
 * The same question the session list answers per row, asked for one
 * conversation. Callers that hold their own idea of which conversations have a
 * card up use this to decide whether that idea is still true, rather than
 * guessing from whether a token was written: a writer can store the very token
 * Claude rejected, which changes nothing about the failure and must not be
 * mistaken for repairing it.
 *
 * Never throws, and answers `false` when it cannot tell. The caller uses this
 * to decide whether to forget that a conversation has a card up, and the two
 * mistakes are not equal: forgetting wrongly costs a redundant secure prompt
 * beside a card, while remembering wrongly suppresses that prompt and points
 * the user at a card that may no longer be there.
 */
export async function conversationHasCurrentAcpMarker(
  conversationId: string,
): Promise<boolean> {
  try {
    const rows = getDb()
      .select({
        agentId: acpSessionHistory.agentId,
        credential: acpSessionHistory.authErrorCredential,
      })
      .from(acpSessionHistory)
      .where(
        and(
          eq(acpSessionHistory.parentConversationId, conversationId),
          isNotNull(acpSessionHistory.authErrorCode),
        ),
      )
      .orderBy(desc(acpSessionHistory.startedAt))
      .limit(MARKER_SCAN_LIMIT)
      .all();
    if (rows.length === 0) {
      return false;
    }
    // Imported at call time: `prepare-agent-env` owns the precedence a spawn
    // applies, and reaching it from here at load would put the whole spawn
    // graph behind this module.
    const { resolvedClaudeCredentialDigest } =
      await import("./prepare-agent-env.js");
    const resolved = new Map<string, string | undefined>();
    for (const row of rows) {
      if (!resolved.has(row.agentId)) {
        resolved.set(
          row.agentId,
          await resolvedClaudeCredentialDigest(row.agentId),
        );
      }
      if (
        acpAuthMarkerStillCurrent(row.credential, resolved.get(row.agentId))
      ) {
        return true;
      }
    }
    return false;
  } catch (err) {
    log.error(
      { err },
      "reading ACP auth markers failed; treating the card as no longer raised",
    );
    return false;
  }
}
