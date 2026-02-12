export type ChannelId = "telegram" | (string & {});

export interface ChannelMeta {
  id: ChannelId;
  label: string;
  docsPath?: string;
}

export interface ChannelCapabilities {
  dm: boolean;
  groups: boolean;
  channels: boolean;
  media: boolean;
}

export interface ChannelConnectInput {
  channelAccountId: string;
  botToken: string;
  webhookUrl: string;
  webhookSecret?: string;
}

export interface ChannelConnectResult {
  externalAccountId?: string;
  username?: string;
  config: Record<string, unknown>;
}

export interface ChannelDisconnectInput {
  botToken: string;
}

export interface ChannelWebhookVerificationInput {
  headers: Headers;
  secret?: string;
}

export interface ChannelSender {
  externalUserId: string;
  username?: string;
  displayName?: string;
}

export interface InboundAttachment {
  filename: string;
  mimeType: string;
  data: string; // base64-encoded
}

export interface NormalizedInboundMessage {
  text: string;
  externalChatId: string;
  externalMessageId: string;
  sender: ChannelSender;
  attachments?: InboundAttachment[];
  raw: Record<string, unknown>;
}

export interface ChannelOutboundTextInput {
  botToken: string;
  chatId: string;
  text: string;
}

export interface ChannelPlugin {
  id: ChannelId;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;
  setup: {
    connect: (input: ChannelConnectInput) => Promise<ChannelConnectResult>;
    disconnect: (input: ChannelDisconnectInput) => Promise<void>;
  };
  inbound: {
    verifyWebhook: (input: ChannelWebhookVerificationInput) => boolean;
    normalizeMessage: (payload: Record<string, unknown>) => NormalizedInboundMessage | null;
  };
  outbound: {
    sendText: (input: ChannelOutboundTextInput) => Promise<void>;
  };
}
