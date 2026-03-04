/**
 * Slack verification DM delivery helper.
 *
 * Sends a verification message to a Slack user's DM via the gateway's
 * /deliver/slack endpoint. The gateway handles opening the DM channel
 * via Slack's conversations.open API and posting the message.
 */

import { getGatewayInternalBaseUrl } from "../../../config/env.js";
import { getLogger } from "../../../util/logger.js";
import { mintDaemonDeliveryToken } from "../../auth/token-service.js";

const log = getLogger("slack-verification-challenge");

/**
 * Deliver a verification code to a Slack user's DM via the gateway.
 * Fire-and-forget with error logging — the caller should not be blocked
 * on gateway/Slack API latency.
 */
export function sendSlackVerificationDm(
  userId: string,
  text: string,
  assistantId: string,
): void {
  (async () => {
    try {
      const gatewayUrl = getGatewayInternalBaseUrl();
      const bearerToken = mintDaemonDeliveryToken();
      const url = `${gatewayUrl}/deliver/slack`;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bearerToken}`,
        },
        body: JSON.stringify({ chatId: userId, text, assistantId }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "<unreadable>");
        log.error(
          { userId, assistantId, status: resp.status, body },
          "Gateway /deliver/slack failed for verification DM",
        );
      } else {
        log.info({ userId, assistantId }, "Slack verification DM delivered");
      }
    } catch (err) {
      log.error(
        { err, userId, assistantId },
        "Failed to deliver Slack verification DM",
      );
    }
  })();
}
