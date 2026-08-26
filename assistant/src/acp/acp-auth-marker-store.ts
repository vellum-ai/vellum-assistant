import { createHash } from "node:crypto";

import { and, eq, isNotNull } from "drizzle-orm";

import { getDb } from "../persistence/db-connection.js";
import { acpSessionHistory } from "../persistence/schema/index.js";
import { credentialKey } from "../security/credential-key.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
import { getLogger } from "../util/logger.js";
import { ACP_OAUTH_TOKEN_FIELD, ACP_SERVICE } from "./acp-credentials.js";

const log = getLogger("acp-auth-marker-store");

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
 * Whether Claude has refused this token on some run whose marker still stands.
 *
 * Read from the marker rows rather than a process-local set. A configured
 * `acp.agents.<id>.env.CLAUDE_CODE_OAUTH_TOKEN` outlives the daemon, so a
 * rejection remembered only in memory is forgotten by the next restart and the
 * revoked value is trusted on sight again, which reopens the Connect loop it
 * was recorded to close.
 *
 * Never throws: this only ever widens or narrows which token a spawn prefers,
 * and a read failure must not take the spawn with it.
 */
export function claudeTokenRefusedByClaude(token: string): boolean {
  const digest = claudeTokenDigest(token);
  try {
    const row = getDb()
      .select({ id: acpSessionHistory.id })
      .from(acpSessionHistory)
      .where(
        and(
          isNotNull(acpSessionHistory.authErrorCode),
          eq(acpSessionHistory.authErrorCredential, digest),
        ),
      )
      .limit(1)
      .get();
    return row !== undefined;
  } catch (err) {
    log.error(
      { err },
      "reading ACP auth markers failed; treating the token as untried",
    );
    return false;
  }
}

/**
 * Digest of the Claude OAuth token secure storage holds right now, or
 * `undefined` when it holds none.
 *
 * The credential a marker is judged against. A configured
 * `CLAUDE_CODE_OAUTH_TOKEN` that Claude has already refused stands down at the
 * next spawn, so once a token carries a marker the vault value is what a spawn
 * goes on to resolve, and comparing against it answers whether the marker
 * still describes the credential in use.
 *
 * Read on demand rather than cached. The vault is the authority on what it
 * holds, and a copy of that answer in this process is a second one that has to
 * be kept in step with every write, including writes this process did not
 * make.
 */
export async function storedClaudeTokenDigest(): Promise<string | undefined> {
  const token = await getSecureKeyAsync(
    credentialKey(ACP_SERVICE, ACP_OAUTH_TOKEN_FIELD),
  );
  return token ? claudeTokenDigest(token) : undefined;
}
