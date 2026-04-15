import {
  getMessageWithHeaders,
  sendMessage,
} from "../../../../messaging/providers/outlook/client.js";
import { resolveOAuthConnection } from "../../../../oauth/connection-resolver.js";
import {
  isPrivateOrLocalHost,
  resolveHostAddresses,
} from "../../../../tools/network/url-safety.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import {
  err,
  ok,
  pinnedHttpsRequest,
  resolveRequestAddress,
} from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const account = input.account as string | undefined;
  if (!context.triggeredBySurfaceAction && !context.batchAuthorizedByTask) {
    return err(
      "This tool requires either a surface action or a scheduled task run with this tool in required_tools. Present results in a selection table with action buttons and wait for the user to click before proceeding.",
    );
  }

  const messageId = input.message_id as string;

  if (!messageId) {
    return err("message_id is required.");
  }

  try {
    const connection = await resolveOAuthConnection("outlook", {
      account,
    });
    const message = await getMessageWithHeaders(connection, messageId);
    const headers = message.internetMessageHeaders ?? [];
    const unsubHeader = headers.find(
      (h) => h.name.toLowerCase() === "list-unsubscribe",
    )?.value;

    if (!unsubHeader) {
      return err(
        "No List-Unsubscribe header found. Manual unsubscribe may be required.",
      );
    }

    const httpsMatch = unsubHeader.match(/<(https:\/\/[^>]+)>/);
    const mailtoMatch = unsubHeader.match(/<mailto:([^>]+)>/);
    const postHeader = headers.find(
      (h) => h.name.toLowerCase() === "list-unsubscribe-post",
    )?.value;

    if (httpsMatch) {
      const url = httpsMatch[1];
      let parsed: URL;
      let validatedAddresses: string[];
      try {
        parsed = new URL(url);
        if (parsed.protocol !== "https:") {
          return err("Unsubscribe URL must use HTTPS.");
        }
        if (isPrivateOrLocalHost(parsed.hostname)) {
          return err("Unsubscribe URL points to a private or local address.");
        }
        const { addresses, blockedAddress } = await resolveRequestAddress(
          parsed.hostname,
          resolveHostAddresses,
          false,
        );
        if (blockedAddress) {
          return err("Unsubscribe URL resolves to a private or local address.");
        }
        if (addresses.length === 0) {
          return err("Unable to resolve unsubscribe URL hostname.");
        }
        validatedAddresses = addresses;
      } catch {
        return err("Invalid unsubscribe URL.");
      }

      const method = postHeader ? "POST" : "GET";
      const reqOpts = postHeader
        ? {
            method: "POST" as const,
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: postHeader,
          }
        : undefined;

      let lastStatus = 0;
      for (const address of validatedAddresses) {
        try {
          lastStatus = await pinnedHttpsRequest(parsed, address, reqOpts);
          if (lastStatus >= 200 && lastStatus < 400) {
            return ok(`Successfully unsubscribed via HTTPS ${method}.`);
          }
        } catch {
          continue;
        }
      }
      return err(`Unsubscribe request failed: ${lastStatus}`);
    }

    if (mailtoMatch) {
      const mailtoAddr = mailtoMatch[1].split("?")[0];
      await sendMessage(connection, {
        message: {
          subject: "Unsubscribe",
          body: { contentType: "text", content: "" },
          toRecipients: [{ emailAddress: { address: mailtoAddr } }],
        },
      });
      return ok(`Unsubscribe email sent to ${mailtoAddr}.`);
    }

    return err(
      "No supported unsubscribe method found (requires https: or mailto: URL).",
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
