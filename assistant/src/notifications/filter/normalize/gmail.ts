/**
 * Gmail normalizer.
 *
 * Gmail's poll returns a snippet, not a body, so `normalize` leaves
 * `content.full` null and the body costs a second `messages.get`. That is what
 * `fetchFull` is for, and why the judgment layer tiers on the preview first.
 */

import {
  batchGetMessages,
  GMAIL_REQUIRED_SCOPES,
} from "../../../messaging/providers/gmail/client.js";
import {
  extractPlainTextBody,
  parseFromHeader,
} from "../../../messaging/providers/gmail/message-fields.js";
import { resolveOAuthConnection } from "../../../oauth/connection-resolver.js";
import { getLogger } from "../../../util/logger.js";
import type { WatcherItem } from "../../../watcher/provider-types.js";
import { attachContactId } from "./resolve-sender.js";
import type {
  NormalizedNotification,
  NotificationCategory,
  NotificationNormalizer,
} from "./types.js";

const log = getLogger("notification-filter:gmail");

/** Credential service backing the Gmail watcher provider. */
const GMAIL_CREDENTIAL_SERVICE = "google";

/** Gmail labels that mark bulk mail regardless of who it is addressed to. */
const BROADCAST_LABEL_IDS = ["CATEGORY_PROMOTIONS", "CATEGORY_UPDATES"];

/** Header keys the watcher payload hoists to top-level scalars. */
const HOISTED_HEADER_KEYS = ["from", "subject", "date", "to", "cc"];

/**
 * Case-insensitive header reader over a Gmail watcher payload. The payload
 * carries a few headers as top-level scalars and may carry the rest under a
 * `headers` record; both forms answer the same lookup.
 */
function headerReader(
  payload: Record<string, unknown>,
): (name: string) => string | null {
  const headers = new Map<string, string>();
  const raw = payload.headers;
  if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "string" && value.length > 0) {
        headers.set(key.toLowerCase(), value);
      }
    }
  }
  for (const key of HOISTED_HEADER_KEYS) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0 && !headers.has(key)) {
      headers.set(key, value);
    }
  }
  return (name: string) => headers.get(name.toLowerCase()) ?? null;
}

/**
 * The addresses in an RFC 5322 address list, lowercased.
 *
 * Splitting on commas is enough for the comparison below: a display name that
 * contains a comma is quoted, so the fragments it splits into still carry the
 * angle-bracketed address, and a fragment with no address at all cannot match
 * the mailbox anyway.
 */
function parseAddressList(value: string | null): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => {
      const bracketed = entry.match(/<([^>]+)>/);
      return (bracketed?.[1] ?? entry).trim().toLowerCase();
    })
    .filter((entry) => entry.length > 0);
}

function readLabelIds(payload: Record<string, unknown>): string[] {
  const labelIds = payload.labelIds;
  if (!Array.isArray(labelIds)) {
    return [];
  }
  return labelIds.filter((id): id is string => typeof id === "string");
}

/**
 * Categorize from headers the watcher already carries, with no network I/O on
 * a path that runs for every polled message.
 *
 * Bulk mail wins over everything else. `dm` then means the mailbox is the sole
 * address in `To`: the message was written to the user and to nobody else,
 * whoever else was copied on it. That is a comparison against the authenticated
 * mailbox address, not an inference from how many recipients a message names,
 * which is why a one-address list alias does not read as a direct message and
 * a direct message with a colleague in `Cc` still does. Without that address
 * there is nothing to compare, so the message falls through rather than being
 * guessed at.
 */
function categorize(
  header: (name: string) => string | null,
  labelIds: string[],
  mailboxAddress: string | null,
): NotificationCategory {
  if (
    header("List-Unsubscribe") ||
    labelIds.some((id) => BROADCAST_LABEL_IDS.includes(id))
  ) {
    return "broadcast";
  }

  if (mailboxAddress) {
    const to = parseAddressList(header("To"));
    if (to.length === 1 && to[0] === mailboxAddress) {
      return "dm";
    }
  }

  return header("In-Reply-To") ? "reply" : "fyi";
}

/** The authenticated mailbox address the watcher stamped on the payload. */
function readMailboxAddress(payload: Record<string, unknown>): string | null {
  const value = payload.mailboxAddress;
  if (typeof value !== "string") {
    return null;
  }
  const [address] = parseAddressList(value);
  return address ?? null;
}

export const gmailNormalizer: NotificationNormalizer = {
  source: "gmail",

  normalize(item: WatcherItem): NormalizedNotification | null {
    const payload = item.payload;
    const header = headerReader(payload);

    const snippet = typeof payload.snippet === "string" ? payload.snippet : "";
    const preview = (snippet.trim() || header("Subject") || "").trim();
    if (!preview) {
      log.debug(
        { externalId: item.externalId },
        "Dropping Gmail item with no snippet or subject",
      );
      return null;
    }

    const from = header("From");
    const parsedFrom = from ? parseFromHeader(from) : null;
    const threadId =
      typeof payload.threadId === "string" ? payload.threadId : null;

    return {
      source: "gmail",
      externalId: item.externalId,
      sender: parsedFrom
        ? attachContactId(
            {
              rawId: parsedFrom.address,
              displayName: parsedFrom.displayName,
            },
            "email",
            { address: parsedFrom.address },
          )
        : null,
      container: threadId
        ? { type: "inbox", id: threadId, displayName: null }
        : null,
      content: {
        preview,
        full: null,
        category: categorize(
          header,
          readLabelIds(payload),
          readMailboxAddress(payload),
        ),
      },
      meta: {
        timestamp: item.timestamp,
        nativePriority: null,
        threadReplyCount: null,
        hasAttachments: null,
      },
    };
  },

  async fetchFull(item: NormalizedNotification): Promise<string | null> {
    try {
      const connection = await resolveOAuthConnection(
        GMAIL_CREDENTIAL_SERVICE,
        {
          requiredScopes: GMAIL_REQUIRED_SCOPES,
        },
      );
      const [message] = await batchGetMessages(
        connection,
        [item.externalId],
        "full",
      );
      if (!message) {
        return null;
      }
      return extractPlainTextBody(message) || null;
    } catch (err) {
      log.debug({ err, externalId: item.externalId }, "Gmail fetchFull failed");
      return null;
    }
  },
};
