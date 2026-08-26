import { isNotNull } from "drizzle-orm";

import { getDb } from "../persistence/db-connection.js";
import { acpSessionHistory } from "../persistence/schema/index.js";
import { getLogger } from "../util/logger.js";

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
