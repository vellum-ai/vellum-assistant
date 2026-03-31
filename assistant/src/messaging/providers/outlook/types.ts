/** Minimal Outlook message reference from list endpoint */
export interface OutlookMessageRef {
  id: string;
  conversationId: string;
}

/** Outlook message list/search response (paginated) */
export interface OutlookMessageListResponse {
  value?: OutlookMessage[];
  "@odata.nextLink"?: string;
  "@odata.count"?: number;
}

/** Email address in Microsoft Graph format */
export interface OutlookEmailAddress {
  name?: string;
  address: string;
}

/** Recipient wrapper containing an email address */
export interface OutlookRecipient {
  emailAddress: OutlookEmailAddress;
}

/** Message body with content type */
export interface OutlookItemBody {
  contentType: "text" | "html";
  content: string;
}

/** Full Outlook message from Microsoft Graph */
export interface OutlookMessage {
  id: string;
  conversationId: string;
  subject: string;
  bodyPreview: string;
  body: OutlookItemBody;
  from?: OutlookRecipient;
  toRecipients: OutlookRecipient[];
  ccRecipients: OutlookRecipient[];
  receivedDateTime: string; // ISO 8601
  isRead: boolean;
  hasAttachments: boolean;
  parentFolderId: string;
  categories: string[];
  flag: {
    flagStatus: "notFlagged" | "flagged" | "complete";
  };
}

/** Outlook mail folder */
export interface OutlookMailFolder {
  id: string;
  displayName: string;
  totalItemCount?: number;
  unreadItemCount?: number;
  parentFolderId?: string;
  childFolderCount?: number;
}

/** Outlook mail folder list response */
export interface OutlookMailFolderListResponse {
  value?: OutlookMailFolder[];
  "@odata.nextLink"?: string;
}

/** Payload for sending a message via Microsoft Graph */
export interface OutlookSendMessagePayload {
  message: {
    subject: string;
    body: OutlookItemBody;
    toRecipients: OutlookRecipient[];
    ccRecipients?: OutlookRecipient[];
  };
  saveToSentItems?: boolean;
}

/** Microsoft Graph user profile */
export interface OutlookUserProfile {
  displayName: string;
  mail: string;
  userPrincipalName: string;
}

/** Predicates for matching messages in a mail rule */
export interface OutlookMessageRulePredicates {
  senderContains?: string[];
  subjectContains?: string[];
  bodyContains?: string[];
  fromAddresses?: OutlookRecipient[];
  hasAttachments?: boolean;
  importance?: "low" | "normal" | "high";
}

/** Actions to take when a mail rule matches */
export interface OutlookMessageRuleActions {
  moveToFolder?: string;
  delete?: boolean;
  stopProcessingRules?: boolean;
  markAsRead?: boolean;
  forwardTo?: OutlookRecipient[];
  markImportance?: "low" | "normal" | "high";
}

/** A mail rule for inbox message processing */
export interface OutlookMessageRule {
  id?: string;
  displayName: string;
  sequence: number;
  isEnabled: boolean;
  conditions?: OutlookMessageRulePredicates;
  actions?: OutlookMessageRuleActions;
}

/** Response from listing mail rules */
export interface OutlookMessageRuleListResponse {
  value?: OutlookMessageRule[];
}

/** Automatic reply (out-of-office) settings */
export interface OutlookAutoReplySettings {
  status: "disabled" | "alwaysEnabled" | "scheduled";
  externalAudience: "none" | "contactsOnly" | "all";
  internalReplyMessage?: string;
  externalReplyMessage?: string;
  scheduledStartDateTime?: { dateTime: string; timeZone: string };
  scheduledEndDateTime?: { dateTime: string; timeZone: string };
}

/** Mailbox settings containing automatic replies configuration */
export interface OutlookMailboxSettings {
  automaticRepliesSetting?: OutlookAutoReplySettings;
}

/** Delta query response with pagination support */
export interface OutlookDeltaResponse<T> {
  value?: T[];
  "@odata.deltaLink"?: string;
  "@odata.nextLink"?: string;
}
