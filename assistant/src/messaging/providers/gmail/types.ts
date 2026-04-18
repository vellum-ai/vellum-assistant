/** Minimal Gmail message metadata from list endpoint */
export interface GmailMessageRef {
  id: string;
  threadId: string;
}

/** Gmail message list response */
export interface GmailMessageListResponse {
  messages?: GmailMessageRef[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

/** A single header key-value pair */
export interface GmailHeader {
  name: string;
  value: string;
}

/** Message payload part (recursive for multipart) */
export interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: {
    attachmentId?: string;
    size?: number;
    data?: string; // base64url-encoded
  };
  parts?: GmailMessagePart[];
}

/** Full Gmail message */
export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  payload?: GmailMessagePart;
  sizeEstimate?: number;
  raw?: string;
}

/** Gmail thread response */
export interface GmailThread {
  id: string;
  historyId?: string;
  messages?: GmailMessage[];
}

/** Gmail label */
export interface GmailLabel {
  id: string;
  name: string;
  type?: "system" | "user";
  messageListVisibility?: "show" | "hide";
  labelListVisibility?: "labelShow" | "labelShowIfUnread" | "labelHide";
  messagesTotal?: number;
  messagesUnread?: number;
  threadsTotal?: number;
  threadsUnread?: number;
  color?: {
    textColor?: string;
    backgroundColor?: string;
  };
}

/** Gmail labels list response */
export interface GmailLabelsListResponse {
  labels?: GmailLabel[];
}

/** Gmail profile response */
export interface GmailProfile {
  emailAddress: string;
  messagesTotal?: number;
  threadsTotal?: number;
  historyId?: string;
}

/** Gmail draft response */
export interface GmailDraft {
  id: string;
  message?: GmailMessage;
}

/** Modify request body */
export interface GmailModifyRequest {
  addLabelIds?: string[];
  removeLabelIds?: string[];
}

/** Message format for GET requests */
export type GmailMessageFormat = "minimal" | "full" | "raw" | "metadata";

/** Attachment data from the Gmail API */
export interface GmailAttachment {
  size: number;
  data: string; // base64url-encoded
}

/** Gmail filter criteria */
export interface GmailFilterCriteria {
  from?: string;
  to?: string;
  subject?: string;
  query?: string;
  hasAttachment?: boolean;
  excludeChats?: boolean;
  size?: number;
  sizeComparison?: "larger" | "smaller";
}

/** Gmail filter action */
export interface GmailFilterAction {
  addLabelIds?: string[];
  removeLabelIds?: string[];
  forward?: string;
}

/** Gmail filter */
export interface GmailFilter {
  id: string;
  criteria: GmailFilterCriteria;
  action: GmailFilterAction;
}

/** Gmail filters list response */
export interface GmailFiltersListResponse {
  filter?: GmailFilter[];
}

/** Gmail vacation auto-reply settings */
export interface GmailVacationSettings {
  enableAutoReply: boolean;
  responseSubject?: string;
  responseBodyPlainText?: string;
  responseBodyHtml?: string;
  restrictToContacts?: boolean;
  restrictToDomain?: boolean;
  startTime?: string; // epoch ms as string
  endTime?: string; // epoch ms as string
}
