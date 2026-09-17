import { extractWirePendingAcpConnect } from "@/domains/chat/utils/chat";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import { isClaudeConnected } from "@/hooks/connect-claude-api";
import type { DisplayMessage } from "@/domains/chat/types/types";

export interface RestoreAcpConnectFromHistoryParams {
  messages: DisplayMessage[];
  assistantId: string;
  conversationId: string;
  /**
   * `acpConnectRevision` at the moment this restore was issued. A live raise
   * or conversation switch advances the revision; an older restore must not
   * apply after that.
   */
  revisionAtRestore: number;
  /**
   * Whether this restore still speaks for the current committed snapshot,
   * mounted conversation, and effect instance. Generation, cancellation, and
   * conversation identity belong here so the helper does not read hook refs.
   */
  isCurrent: () => boolean;
  /** Test seam. Production uses {@link isClaudeConnected}. */
  checkConnected?: (assistantId: string) => Promise<boolean>;
}

/**
 * Restore the inline Connect Claude Code prompt from a committed history
 * snapshot, if the snapshot still warrants one.
 *
 * The failed `acp_spawn` `errorCode` lives permanently on the history row, so
 * a conversation that already has a usable stored token still carries an
 * ordinary missing-token marker. That marker is checked against connected
 * status before the interaction store is touched: a connected workspace does
 * not raise, and does not record a dismissal (a later legitimate restore of
 * the same tool-use id must still be able to raise). `auth_required` is
 * raised without that check, because a stored token may be the credential
 * Claude already rejected. A thrown or unavailable check fails open and
 * raises. Raises always go through `showAcpConnect` so its dismissal and
 * flow-active guards stay authoritative.
 */
export async function restoreAcpConnectFromHistory(
  params: RestoreAcpConnectFromHistoryParams,
): Promise<void> {
  const {
    messages,
    assistantId,
    conversationId,
    revisionAtRestore,
    isCurrent,
    checkConnected = isClaudeConnected,
  } = params;

  if (useInteractionStore.getState().pendingAcpConnect) {
    return;
  }

  const wire = extractWirePendingAcpConnect(messages);
  if (!wire) {
    return;
  }

  const payload = { ...wire, conversationId };

  if (wire.reason === "auth_required") {
    if (!isCurrent()) {
      return;
    }
    useInteractionStore.getState().showAcpConnect(payload);
    return;
  }

  let connected = false;
  try {
    connected = await checkConnected(assistantId);
  } catch {
    connected = false;
  }

  if (connected) {
    return;
  }

  if (!isCurrent()) {
    return;
  }

  const store = useInteractionStore.getState();
  if (store.acpConnectRevision !== revisionAtRestore) {
    return;
  }
  if (store.pendingAcpConnect) {
    return;
  }

  store.showAcpConnect(payload);
}
