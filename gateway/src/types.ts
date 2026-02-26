import type { ChannelId } from './channels/types.js';

export type GatewayInboundEventV1 = {
  version: "v1";
  sourceChannel: Extract<ChannelId, 'telegram' | 'sms' | 'whatsapp' | 'slack'>;
  receivedAt: string;
  routing: {
    assistantId: string;
    routeSource: "chat_id" | "user_id" | "default";
  };
  message: {
    content: string;
    externalChatId: string;
    externalMessageId: string;
    isEdit?: boolean;
    callbackQueryId?: string;
    callbackData?: string;
    attachments?: {
      type: "photo" | "document";
      fileId: string;
      fileName?: string;
      mimeType?: string;
      fileSize?: number;
    }[];
  };
  sender: {
    externalUserId: string;
    username?: string;
    displayName?: string;
    firstName?: string;
    lastName?: string;
    languageCode?: string;
    isBot?: boolean;
  };
  source: {
    updateId: string;
    messageId?: string;
    chatType?: string;
  };
  raw: Record<string, unknown>;
};
