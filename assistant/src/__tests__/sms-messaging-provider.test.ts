import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../config/env.js", () => ({ isHttpAuthDisabled: () => true }));

import type { SmsSendResult } from "../messaging/providers/sms/client.js";

const sendSmsMock = mock(
  async (..._args: unknown[]): Promise<SmsSendResult> => ({
    messageSid: "SM-mock-sid",
    status: "queued",
  }),
);
const getOrCreateConversationMock = mock((_key: string) => ({
  conversationId: "conv-1",
}));
const upsertOutboundBindingMock = mock((_input: Record<string, unknown>) => {});

let secureKeys: Record<string, string | undefined> = {
  "credential:twilio:account_sid": "AC1234567890",
  "credential:twilio:auth_token": "auth-token",
};

let configState: {
  twilio?: { accountSid?: string };
  sms?: {
    phoneNumber?: string;
    assistantPhoneNumbers?: Record<string, string>;
  };
} = {
  twilio: { accountSid: "AC1234567890" },
  sms: {},
};

mock.module("../security/secure-keys.js", () => ({
  getSecureKey: (key: string) => secureKeys[key],
}));

mock.module("../runtime/auth/token-service.js", () => ({
  mintDaemonDeliveryToken: () => "runtime-token",
}));

mock.module("../config/loader.js", () => ({
  loadConfig: () => configState,
}));

mock.module("../memory/conversation-key-store.js", () => ({
  getOrCreateConversation: (key: string) => getOrCreateConversationMock(key),
}));

mock.module("../memory/external-conversation-store.js", () => ({
  upsertOutboundBinding: (input: Record<string, unknown>) =>
    upsertOutboundBindingMock(input),
}));

mock.module("../messaging/providers/sms/client.js", () => ({
  sendMessage: (
    gatewayUrl: string,
    bearerToken: string,
    to: string,
    text: string,
    assistantId?: string,
  ) => sendSmsMock(gatewayUrl, bearerToken, to, text, assistantId),
}));

import { smsMessagingProvider } from "../messaging/providers/sms/adapter.js";

describe("smsMessagingProvider", () => {
  beforeEach(() => {
    sendSmsMock.mockClear();
    getOrCreateConversationMock.mockClear();
    upsertOutboundBindingMock.mockClear();
    secureKeys = {
      "credential:twilio:account_sid": "AC1234567890",
      "credential:twilio:auth_token": "auth-token",
    };
    configState = { twilio: { accountSid: "AC1234567890" }, sms: {} };
    delete process.env.TWILIO_PHONE_NUMBER;
    delete process.env.GATEWAY_INTERNAL_BASE_URL;
    delete process.env.GATEWAY_PORT;
  });

  test("isConnected is true when assistant-scoped numbers exist", () => {
    configState = {
      twilio: { accountSid: "AC1234567890" },
      sms: {
        assistantPhoneNumbers: { "ast-alpha": "+15550001111" },
      },
    };

    expect(smsMessagingProvider.isConnected?.()).toBe(true);
  });

  test("sendMessage forwards explicit assistant scope and avoids outbound binding writes for non-self", async () => {
    await smsMessagingProvider.sendMessage("", "+15550002222", "hi", {
      assistantId: "ast-alpha",
    });

    expect(sendSmsMock).toHaveBeenCalledWith(
      "http://127.0.0.1:7830",
      "runtime-token",
      "+15550002222",
      "hi",
      "ast-alpha",
    );
    expect(getOrCreateConversationMock).toHaveBeenCalledWith(
      "asst:ast-alpha:sms:+15550002222",
    );
    expect(upsertOutboundBindingMock).not.toHaveBeenCalled();
  });

  test("sendMessage uses messageSid from gateway response as result ID", async () => {
    sendSmsMock.mockImplementation(async () => ({
      messageSid: "SM-test-12345",
      status: "queued",
    }));
    const result = await smsMessagingProvider.sendMessage(
      "",
      "+15550009999",
      "sid test",
      {
        assistantId: "self",
      },
    );
    expect(result.id).toBe("SM-test-12345");
  });

  test("sendMessage falls back to timestamp-based ID when messageSid is absent", async () => {
    sendSmsMock.mockImplementation(async () => ({}));
    const before = Date.now();
    const result = await smsMessagingProvider.sendMessage(
      "",
      "+15550009999",
      "no sid",
      {
        assistantId: "self",
      },
    );
    expect(result.id).toMatch(/^sms-\d+$/);
    const ts = parseInt(result.id.replace("sms-", ""), 10);
    expect(ts).toBeGreaterThanOrEqual(before);
  });

  test("sendMessage uses canonical self key and writes outbound binding for self scope", async () => {
    await smsMessagingProvider.sendMessage("", "+15550003333", "hello", {
      assistantId: "self",
    });

    expect(getOrCreateConversationMock).toHaveBeenCalledWith(
      "sms:+15550003333",
    );
    expect(upsertOutboundBindingMock).toHaveBeenCalledWith({
      conversationId: "conv-1",
      sourceChannel: "sms",
      externalChatId: "+15550003333",
    });
  });
});
