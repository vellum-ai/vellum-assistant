/**
 * Withdraw a Slack approval card when its underlying guardian request resolves.
 *
 * "Withdraw" preserves the card's information and removes only the live
 * affordances: the original message blocks are fetched, the action buttons are
 * stripped, and a resolved-status line (outcome, decider, time) is appended,
 * then the message is edited in place. This keeps an in-channel audit trail
 * rather than collapsing the card to a bare status.
 *
 * If the original blocks can't be read (missing `*:history` scope, threaded
 * reply, deleted message), it degrades to a status-only edit so the buttons are
 * still removed.
 */

import { getLogger } from "../../../util/logger.js";
import { getSlackMessageBlocks } from "./api.js";
import { sendSlackReply } from "./send.js";

const log = getLogger("slack-withdraw");

const STATUS_GLYPH: Record<string, string> = {
  approved: ":white_check_mark:",
  denied: ":x:",
  expired: ":hourglass_done:",
  cancelled: ":no_entry_sign:",
};

const STATUS_WORD: Record<string, string> = {
  approved: "Approved",
  denied: "Denied",
  expired: "Expired",
  cancelled: "Cancelled",
};

export interface WithdrawSlackApprovalCardParams {
  /** Channel/DM id the approval message lives in. */
  channel: string;
  /** Timestamp (`ts`) of the approval message to edit. */
  messageTs: string;
  /** Terminal status of the request (e.g. "approved", "denied", "expired"). */
  status: string;
  /** Slack user id of the decider, when the decision came from Slack. */
  decidedByExternalUserId?: string;
  /** Decision time (epoch ms) for the audit line. */
  decidedAtMs?: number;
}

/**
 * Build the resolved-status line shown in place of the action buttons.
 * Uses Slack's `<!date>` token so the time renders in each viewer's timezone.
 */
function buildStatusText(params: WithdrawSlackApprovalCardParams): string {
  const glyph = STATUS_GLYPH[params.status] ?? "";
  const word = STATUS_WORD[params.status] ?? "Resolved";
  let line = glyph ? `${glyph} *${word}*` : `*${word}*`;
  if (params.decidedByExternalUserId) {
    line += ` by <@${params.decidedByExternalUserId}>`;
  }
  if (params.decidedAtMs && Number.isFinite(params.decidedAtMs)) {
    const seconds = Math.floor(params.decidedAtMs / 1000);
    const fallback = new Date(params.decidedAtMs).toISOString();
    line += ` · <!date^${seconds}^{date_short_pretty} at {time}|${fallback}>`;
  }
  return line;
}

/**
 * Remove interactive affordances from a fetched message's blocks: drop
 * standalone `actions` rows and strip the `actions` array from native `card`
 * blocks, leaving all informational content intact.
 */
export function stripApprovalActionBlocks(blocks: unknown[]): unknown[] {
  const result: unknown[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") {
      result.push(block);
      continue;
    }
    const b = block as Record<string, unknown>;
    if (b.type === "actions") continue;
    if (b.type === "card" && "actions" in b) {
      const { actions: _removed, ...rest } = b;
      result.push(rest);
      continue;
    }
    result.push(block);
  }
  return result;
}

/**
 * Edit a Slack approval message in place to its resolved state, preserving the
 * card content and dropping its buttons. Best-effort: throws only on the final
 * edit call failing, which the caller treats as non-fatal.
 */
export async function withdrawSlackApprovalCard(
  params: WithdrawSlackApprovalCardParams,
): Promise<void> {
  const statusText = buildStatusText(params);
  const statusBlock = {
    type: "context",
    elements: [{ type: "mrkdwn", text: statusText }],
  };

  let preserved: unknown[] | null = null;
  try {
    const original = await getSlackMessageBlocks(
      params.channel,
      params.messageTs,
    );
    if (original && original.length > 0) {
      preserved = [...stripApprovalActionBlocks(original), statusBlock];
    }
  } catch (err) {
    log.warn(
      { err, channel: params.channel, messageTs: params.messageTs },
      "Could not read original Slack approval card; collapsing to status only",
    );
  }

  const blocks = preserved ?? [
    { type: "section", text: { type: "mrkdwn", text: statusText } },
  ];

  await sendSlackReply(params.channel, statusText, {
    messageTs: params.messageTs,
    blocks,
    useBlocks: true,
  });
}
