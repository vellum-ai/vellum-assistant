// Document comment event types (Server → Client).

import type { DocumentCommentCreatedEvent } from "../../api/events/document-comment-created.js";
import type { DocumentCommentDeletedEvent } from "../../api/events/document-comment-deleted.js";
import type { DocumentCommentReopenedEvent } from "../../api/events/document-comment-reopened.js";
import type { DocumentCommentResolvedEvent } from "../../api/events/document-comment-resolved.js";

// --- Domain-level union alias (consumed by the barrel file) ---

export type _DocumentCommentsServerMessages =
  | DocumentCommentCreatedEvent
  | DocumentCommentResolvedEvent
  | DocumentCommentReopenedEvent
  | DocumentCommentDeletedEvent;
