// Document comment event types (Server → Client).

export interface DocumentCommentCreated {
  type: "document_comment_created";
  conversationId: string;
  surfaceId: string;
  comment: {
    id: string;
    surfaceId: string;
    author: string;
    content: string;
    anchorStart?: number;
    anchorEnd?: number;
    anchorText?: string;
    parentCommentId?: string;
    status: string;
    createdAt: number;
    updatedAt: number;
  };
}

export interface DocumentCommentResolved {
  type: "document_comment_resolved";
  conversationId: string;
  surfaceId: string;
  commentId: string;
  resolvedBy: string;
}

export interface DocumentCommentReopened {
  type: "document_comment_reopened";
  conversationId: string;
  surfaceId: string;
  commentId: string;
}

export interface DocumentCommentDeleted {
  type: "document_comment_deleted";
  conversationId: string;
  surfaceId: string;
  commentId: string;
}

// --- Domain-level union alias (consumed by the barrel file) ---

export type _DocumentCommentsServerMessages =
  | DocumentCommentCreated
  | DocumentCommentResolved
  | DocumentCommentReopened
  | DocumentCommentDeleted;
