/**
 * Withdraw a Discord approval card when its underlying guardian request
 * resolves.
 *
 * A Discord card is plain text whose actionable tail (the typed-command
 * instructions) rides the last chunk, and that chunk's id is what the
 * delivery row captured. Rewriting it to the terminal outcome removes every
 * live affordance and shows the decision in one edit, so no separate status
 * reply is needed. The delivery row's chat id is the guardian's *user*
 * snowflake, never a room: the DM channel is resolved from the person at
 * withdrawal time, the same way the adapter resolved it to deliver.
 */

import {
  isParkAction,
  resolveDecisionStatusWord,
} from "../../../runtime/channel-approval-types.js";
import { getLogger } from "../../../util/logger.js";
import { openDiscordDmChannel } from "./api.js";
import { editDiscordMessage } from "./send.js";

const log = getLogger("discord-withdraw");

const STATUS_GLYPH: Record<string, string> = {
  approved: "✅",
  denied: "❌",
  expired: "⌛",
};

const PARK_STATUS_GLYPH = "⏸️";

function buildStatusText(status: string, decidedAction?: string): string {
  const park = status === "denied" && isParkAction(decidedAction);
  const glyph = park ? PARK_STATUS_GLYPH : (STATUS_GLYPH[status] ?? "");
  const word = resolveDecisionStatusWord(status, decidedAction);
  return glyph ? `${glyph} ${word}` : word;
}

export interface WithdrawDiscordApprovalCardParams {
  /** The guardian's user snowflake from the delivery row. */
  guardianUserId: string;
  /** The card's last-chunk message id from the delivery row. */
  messageId: string;
  status: string;
  decidedAction?: string;
}

export async function withdrawDiscordApprovalCard(
  params: WithdrawDiscordApprovalCardParams,
): Promise<void> {
  const channelId = await openDiscordDmChannel(params.guardianUserId);
  await editDiscordMessage(
    { channelId },
    params.messageId,
    buildStatusText(params.status, params.decidedAction),
    { emphasis: "muted" },
  );
  log.info(
    { guardianUserId: params.guardianUserId, messageId: params.messageId },
    "Discord approval card withdrawn",
  );
}
