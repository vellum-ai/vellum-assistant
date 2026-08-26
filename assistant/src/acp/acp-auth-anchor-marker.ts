import { ACP_CLAUDE_AUTH_REQUIRED_CODE } from "../api/events/acp-auth-required.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("acp-auth-anchor-marker");

/**
 * Internal rider naming the auth failure that killed a run, stamped on the
 * `tool_use` block that spawned it. Same convention as `_startedAt` and
 * `_confirmationDecision`: an underscore-prefixed field the history renderer
 * translates into a wire field, invisible to the model's own view of the turn.
 */
export const ACP_AUTH_ERROR_CODE_RIDER = "_acpAuthErrorCode";

/**
 * Whether these blocks carry the `tool_use` with this id. Pure so the anchor
 * scan's matching rule is testable without a database behind it.
 */
export function blocksCarryToolUse(
  blocks: readonly unknown[],
  toolUseId: string,
): boolean {
  return blocks.some((block) => {
    const rec = block as Record<string, unknown>;
    return rec?.type === "tool_use" && rec.id === toolUseId;
  });
}

/**
 * Stamp the rider on the matching `tool_use` block, reporting whether anything
 * changed. Mutates in place, the way the turn-time stampers do, so the caller
 * can serialize the same array it read. Already-stamped blocks report `false`,
 * which is what keeps a repeat failure on one run from rewriting the row.
 */
export function applyAcpAuthRider(
  blocks: readonly unknown[],
  toolUseId: string,
): boolean {
  for (const block of blocks) {
    const rec = block as Record<string, unknown>;
    if (rec?.type !== "tool_use" || rec.id !== toolUseId) {
      continue;
    }
    if (rec[ACP_AUTH_ERROR_CODE_RIDER] === ACP_CLAUDE_AUTH_REQUIRED_CODE) {
      return false;
    }
    rec[ACP_AUTH_ERROR_CODE_RIDER] = ACP_CLAUDE_AUTH_REQUIRED_CODE;
    return true;
  }
  return false;
}

/**
 * Record on persisted history that this run's Claude credential was rejected,
 * so a client that reloads can re-raise the inline Connect card.
 *
 * The pre-spawn rejection carries its classification on the failed
 * `acp_spawn` tool result, which history already persists. A mid-run rejection
 * has no such result to carry it: the spawn succeeded, the tool call completed
 * clean, and the failure arrives later as its own event. Live clients take that
 * event, but a cold start has only history to read, and history says the spawn
 * worked. The card silently fails to come back, while the daemon's own
 * prompt-dedup registry keeps redirecting the secure-prompt fallback at it.
 *
 * Best-effort by design. The live event is what raises the card in the session
 * that saw the failure; this only decides whether the next cold start can
 * re-derive it, so a missing anchor or a busy database is logged and dropped
 * rather than allowed to interrupt session teardown.
 */
export async function stampAcpAuthRequiredOnAnchor(
  conversationId: string | undefined,
  toolUseId: string | undefined,
): Promise<void> {
  if (!conversationId || !toolUseId) {
    return;
  }
  try {
    // Imported here rather than at module scope. The session manager keeps a
    // deliberately narrow persistence graph (`db-connection` and the schema),
    // and reaching conversation CRUD from its top level pulls the whole
    // message-write stack, and everything that stack imports, into every
    // module that touches ACP. This path runs once per run that dies on auth,
    // so the cost of loading it on demand is nothing.
    const [{ updateMessageContent }, { resolveMessageContentBlocks }, reads] =
      await Promise.all([
        import("../persistence/conversation-crud.js"),
        import("../persistence/message-content-file.js"),
        import("../persistence/message-reads.js"),
      ]);

    let messageId: string | null = null;
    for (const row of reads.recentAssistantMessageContents(conversationId)) {
      if (
        blocksCarryToolUse(resolveMessageContentBlocks(row.content), toolUseId)
      ) {
        messageId = row.id;
        break;
      }
    }
    if (messageId === null) {
      log.warn(
        { conversationId, toolUseId },
        "no anchor tool_use found; Connect card will not survive a reload",
      );
      return;
    }

    const raw = reads.messageRawContent(messageId);
    if (raw === null) {
      return;
    }
    const blocks = resolveMessageContentBlocks(raw);
    if (applyAcpAuthRider(blocks, toolUseId)) {
      updateMessageContent(messageId, JSON.stringify(blocks));
    }
  } catch (err) {
    log.error(
      { err, conversationId, toolUseId },
      "stamping the ACP auth anchor failed; the card still raises live",
    );
  }
}
