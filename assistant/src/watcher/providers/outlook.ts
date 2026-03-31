/**
 * Outlook watcher provider — uses Microsoft Graph delta queries for efficient
 * change detection.
 *
 * On first poll, captures the initial deltaLink as the watermark (start from "now").
 * Subsequent polls use the deltaLink to detect new messages.
 * Falls back to listing recent inbox messages if the sync state has expired (410 Gone).
 */

import {
  listMessages,
  listMessagesDelta,
  OutlookApiError,
} from "../../messaging/providers/outlook/client.js";
import type {
  OutlookDeltaResponse,
  OutlookMessage,
} from "../../messaging/providers/outlook/types.js";
import type { OAuthConnection } from "../../oauth/connection.js";
import { resolveOAuthConnection } from "../../oauth/connection-resolver.js";
import { getLogger } from "../../util/logger.js";
import type {
  FetchResult,
  WatcherItem,
  WatcherProvider,
} from "../provider-types.js";

const log = getLogger("watcher:outlook");

/** Thrown when Microsoft Graph returns 410 Gone (delta sync state expired). */
export class DeltaSyncExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeltaSyncExpiredError";
  }
}

function messageToItem(msg: OutlookMessage): WatcherItem {
  const from =
    msg.from?.emailAddress?.name ||
    msg.from?.emailAddress?.address ||
    "Unknown";
  const subject = msg.subject ?? "(no subject)";

  return {
    externalId: msg.id,
    eventType: "new_email",
    summary: `Email from ${from}: ${subject}`,
    payload: {
      id: msg.id,
      conversationId: msg.conversationId,
      from,
      fromAddress: msg.from?.emailAddress?.address ?? "",
      subject,
      receivedDateTime: msg.receivedDateTime,
      bodyPreview: msg.bodyPreview ?? "",
      isRead: msg.isRead ?? false,
      hasAttachments: msg.hasAttachments ?? false,
    },
    timestamp: msg.receivedDateTime
      ? new Date(msg.receivedDateTime).getTime()
      : Date.now(),
  };
}

/**
 * Fetch all pages of a delta response, following @odata.nextLink until
 * a @odata.deltaLink is returned.
 */
async function fetchAllDeltaPages(
  connection: OAuthConnection,
  folderId: string,
  deltaLink?: string,
): Promise<{ messages: OutlookMessage[]; newDeltaLink: string }> {
  const messages: OutlookMessage[] = [];

  let resp: OutlookDeltaResponse<OutlookMessage>;
  try {
    resp = await listMessagesDelta(connection, folderId, deltaLink);
  } catch (err) {
    if (err instanceof OutlookApiError && err.status === 410) {
      throw new DeltaSyncExpiredError(err.message);
    }
    throw err;
  }

  if (resp.value) {
    messages.push(...resp.value);
  }

  // Follow pagination until we get a deltaLink
  while (resp["@odata.nextLink"] && !resp["@odata.deltaLink"]) {
    try {
      resp = await listMessagesDelta(
        connection,
        folderId,
        resp["@odata.nextLink"],
      );
    } catch (err) {
      if (err instanceof OutlookApiError && err.status === 410) {
        throw new DeltaSyncExpiredError(
          err instanceof Error ? err.message : String(err),
        );
      }
      throw err;
    }
    if (resp.value) {
      messages.push(...resp.value);
    }
  }

  const newDeltaLink = resp["@odata.deltaLink"];
  if (!newDeltaLink) {
    throw new Error(
      "Outlook delta query completed without returning a deltaLink",
    );
  }

  return { messages, newDeltaLink };
}

export const outlookProvider: WatcherProvider = {
  id: "outlook",
  displayName: "Outlook",
  requiredCredentialService: "outlook",

  async getInitialWatermark(credentialService: string): Promise<string> {
    const connection = await resolveOAuthConnection(credentialService);
    const { newDeltaLink } = await fetchAllDeltaPages(connection, "inbox");
    return newDeltaLink;
  },

  async fetchNew(
    credentialService: string,
    watermark: string | null,
    _config: Record<string, unknown>,
    _watcherKey: string,
  ): Promise<FetchResult> {
    const connection = await resolveOAuthConnection(credentialService);

    if (!watermark) {
      // No watermark — get initial position, return no items
      const { newDeltaLink } = await fetchAllDeltaPages(connection, "inbox");
      return { items: [], watermark: newDeltaLink };
    }

    try {
      const { messages, newDeltaLink } = await fetchAllDeltaPages(
        connection,
        "inbox",
        watermark,
      );

      if (messages.length === 0) {
        return { items: [], watermark: newDeltaLink };
      }

      const items = messages.map(messageToItem);
      log.info(
        { count: items.length, watermark: newDeltaLink },
        "Outlook: fetched new messages",
      );

      return { items, watermark: newDeltaLink };
    } catch (err) {
      if (err instanceof DeltaSyncExpiredError) {
        log.warn(
          "Outlook delta sync state expired, falling back to recent inbox messages",
        );
        return fallbackFetch(connection);
      }
      throw err;
    }
  },
};

/**
 * Fallback when sync state expires (410 Gone): list recent inbox messages
 * from the last day, then get a fresh deltaLink.
 */
async function fallbackFetch(
  connection: OAuthConnection,
): Promise<FetchResult> {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const resp = await listMessages(connection, {
    folderId: "inbox",
    top: 20,
    filter: `receivedDateTime ge ${oneDayAgo}`,
    orderby: "receivedDateTime desc",
  });

  const items = (resp.value ?? []).map(messageToItem);

  // Get a fresh deltaLink for the new watermark
  const { newDeltaLink } = await fetchAllDeltaPages(connection, "inbox");

  return { items, watermark: newDeltaLink };
}
