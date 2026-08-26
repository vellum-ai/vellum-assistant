import { isNotNull } from "drizzle-orm";

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
 * Retire everything a past Claude auth failure left behind, because a new
 * token has just been written.
 *
 * Three writers reach the `acp/claude_oauth_token` field: the Connect flow
 * (`storeAcpClaudeToken`), the generic credential writer (`assistant
 * credentials set`), and the headless secure prompt. A token repaired through
 * any of them repairs the ACP runs equally, so all three call this rather than
 * the Connect flow owning the behaviour and the other two silently leaving
 * markers behind.
 *
 * The generation bump comes first, so a rejection racing this write sees the
 * newer generation and declines to re-mark rather than landing after the
 * sweep.
 */
export function retireAcpAuthRecovery(): void {
  claudeCredentialGeneration += 1;
  clearAcpAuthMarkers();
  takeConversationsWithAcpConnectCard();
}
