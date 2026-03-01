export type ManagedInboundChannelId = "sms" | "voice";

export type ManagedGatewayInboundEvent = {
  version: "v1";
  sourceChannel: ManagedInboundChannelId;
  receivedAt: string;
  message: {
    content: string;
    conversationExternalId: string;
    externalMessageId: string;
  };
  actor: {
    actorExternalId: string;
    displayName?: string;
  };
  source: {
    updateId: string;
    messageId?: string;
    [key: string]: string | undefined;
  };
  raw: Record<string, unknown>;
};
