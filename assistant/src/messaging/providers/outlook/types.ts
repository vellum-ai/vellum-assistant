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
