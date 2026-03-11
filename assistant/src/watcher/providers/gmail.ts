/**
 * Gmail watcher provider — uses the History API for efficient change detection.
 *
 * On first poll, captures the current historyId as the watermark (start from "now").
 * Subsequent polls use history.list with historyTypes=messageAdded to detect new messages.
 * Falls back to listing recent unread messages if the historyId has expired (404).
 */

import {
  batchGetMessages,
  getProfile,
  listMessages,
} from "../../messaging/providers/gmail/client.js";
import type { GmailMessage } from "../../messaging/providers/gmail/types.js";
import type { OAuthConnection } from "../../oauth/connection.js";
import { resolveOAuthConnection } from "../../oauth/connection-resolver.js";
import { getLogger } from "../../util/logger.js";
import type {
  FetchResult,
  WatcherItem,
  WatcherProvider,
} from "../provider-types.js";

const log = getLogger("watcher:gmail");

/** Gmail History API response types */
interface HistoryMessage {
  id: string;
  threadId: string;
}

interface HistoryRecord {
  id: string;
  messagesAdded?: Array<{ message: HistoryMessage }>;
}

interface HistoryListResponse {
  history?: HistoryRecord[];
  nextPageToken?: string;
  historyId?: string;
}

function extractHeader(msg: GmailMessage, name: string): string {
  return (
    msg.payload?.headers?.find(
      (h) => h.name.toLowerCase() === name.toLowerCase(),
    )?.value ?? ""
  );
}

function messageToItem(msg: GmailMessage): WatcherItem {
  const from = extractHeader(msg, "From");
  const subject = extractHeader(msg, "Subject");
  const date = extractHeader(msg, "Date");

  return {
    externalId: msg.id,
    eventType: "new_email",
    summary: `Email from ${from}: ${subject}`,
    payload: {
      id: msg.id,
      threadId: msg.threadId,
      from,
      subject,
      date,
      snippet: msg.snippet ?? "",
      labelIds: msg.labelIds ?? [],
    },
    timestamp: msg.internalDate ? parseInt(msg.internalDate, 10) : Date.now(),
  };
}

async function fetchHistory(
  connection: OAuthConnection,
  startHistoryId: string,
): Promise<HistoryListResponse> {
  const query: Record<string, string> = {
    startHistoryId,
    historyTypes: "messageAdded",
    maxResults: "100",
  };

  const resp = await connection.request({
    method: "GET",
    path: "/history",
    query,
  });

  if (resp.status === 404) {
    const body =
      typeof resp.body === "string"
        ? resp.body
        : JSON.stringify(resp.body ?? "");
    throw new HistoryExpiredError(body);
  }

  if (resp.status < 200 || resp.status >= 300) {
    const body =
      typeof resp.body === "string"
        ? resp.body
        : JSON.stringify(resp.body ?? "");
    throw new Error(`Gmail History API ${resp.status}: ${body}`);
  }

  return resp.body as HistoryListResponse;
}

class HistoryExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoryExpiredError";
  }
}

export const gmailProvider: WatcherProvider = {
  id: "gmail",
  displayName: "Gmail",
  requiredCredentialService: "integration:gmail",

  async getInitialWatermark(credentialService: string): Promise<string> {
    const connection = resolveOAuthConnection(credentialService);
    const profile = await getProfile(connection);
    if (!profile.historyId) {
      throw new Error("Gmail profile did not return a historyId");
    }
    return profile.historyId;
  },

  async fetchNew(
    credentialService: string,
    watermark: string | null,
    _config: Record<string, unknown>,
    _watcherKey: string,
  ): Promise<FetchResult> {
    const connection = resolveOAuthConnection(credentialService);

    if (!watermark) {
      // No watermark — get initial position, return no items
      const profile = await getProfile(connection);
      return { items: [], watermark: profile.historyId ?? "0" };
    }

    try {
      const historyResp = await fetchHistory(connection, watermark);
      const newWatermark = historyResp.historyId ?? watermark;

      if (!historyResp.history || historyResp.history.length === 0) {
        return { items: [], watermark: newWatermark };
      }

      // Collect unique new message IDs
      const messageIds = new Set<string>();
      for (const record of historyResp.history) {
        if (record.messagesAdded) {
          for (const added of record.messagesAdded) {
            messageIds.add(added.message.id);
          }
        }
      }

      if (messageIds.size === 0) {
        return { items: [], watermark: newWatermark };
      }

      // Fetch metadata for new messages
      const messages = await batchGetMessages(
        connection,
        Array.from(messageIds),
        "metadata",
        ["From", "Subject", "Date"],
      );

      // Only include INBOX messages (skip sent, drafts, etc.)
      const inboxMessages = messages.filter((m) =>
        m.labelIds?.includes("INBOX"),
      );

      const items = inboxMessages.map(messageToItem);
      log.info(
        { count: items.length, watermark: newWatermark },
        "Gmail: fetched new messages",
      );

      return { items, watermark: newWatermark };
    } catch (err) {
      if (err instanceof HistoryExpiredError) {
        log.warn(
          "Gmail historyId expired, falling back to recent unread messages",
        );
        return fallbackFetch(connection);
      }
      throw err;
    }
  },
};

/**
 * Fallback when historyId expires: list recent unread inbox messages.
 */
async function fallbackFetch(
  connection: OAuthConnection,
): Promise<FetchResult> {
  const listResp = await listMessages(
    connection,
    "is:unread newer_than:1d",
    20,
    undefined,
    ["INBOX"],
  );

  if (!listResp.messages || listResp.messages.length === 0) {
    const profile = await getProfile(connection);
    return { items: [], watermark: profile.historyId ?? "0" };
  }

  const messages = await batchGetMessages(
    connection,
    listResp.messages.map((m) => m.id),
    "metadata",
    ["From", "Subject", "Date"],
  );

  const items = messages.map(messageToItem);

  // Get fresh historyId for the new watermark
  const profile = await getProfile(connection);
  return { items, watermark: profile.historyId ?? "0" };
}
