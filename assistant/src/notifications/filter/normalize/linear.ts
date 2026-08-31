/**
 * Linear normalizer.
 *
 * Linear returns everything the filter needs in its poll (issue title, comment
 * body, team), so there is no `fetchFull`: `content.full` is populated inline.
 * Linear notifications name the issue, not the person who triggered them, so
 * `sender` is always null.
 */

import { getLogger } from "../../../util/logger.js";
import type { WatcherItem } from "../../../watcher/provider-types.js";
import type {
  NormalizedNotification,
  NotificationCategory,
  NotificationNormalizer,
} from "./types.js";

const log = getLogger("notification-filter:linear");

/** Watcher event types produced by `providers/linear.ts`. */
const CATEGORY_BY_EVENT_TYPE: Record<string, NotificationCategory> = {
  linear_issue_assigned: "assignment",
  linear_mention: "mention",
  linear_comment_mention: "mention",
  linear_status_changed: "fyi",
  linear_notification: "fyi",
};

/** Unrecognized event types degrade to `fyi` rather than throwing. */
function categoryFor(eventType: string): NotificationCategory {
  return CATEGORY_BY_EVENT_TYPE[eventType] ?? "fyi";
}

function readString(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export const linearNormalizer: NotificationNormalizer = {
  source: "linear",

  normalize(item: WatcherItem): NormalizedNotification | null {
    const preview = item.summary.trim();
    if (!preview) {
      log.debug(
        { externalId: item.externalId },
        "Dropping Linear item with no summary",
      );
      return null;
    }

    const payload = item.payload;
    const issueId = readString(payload, "issueId");

    return {
      source: "linear",
      externalId: item.externalId,
      sender: null,
      container: issueId
        ? {
            type: "project",
            id: issueId,
            displayName: readString(payload, "teamName"),
          }
        : null,
      content: {
        preview,
        full:
          readString(payload, "commentBody") ??
          readString(payload, "issueTitle"),
        category: categoryFor(item.eventType),
      },
      meta: {
        timestamp: item.timestamp,
        nativePriority: null,
        threadReplyCount: null,
        hasAttachments: null,
      },
    };
  },
};
