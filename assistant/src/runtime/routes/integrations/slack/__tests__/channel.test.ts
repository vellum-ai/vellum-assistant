/**
 * Unit tests for the POST /v1/integrations/slack/channel/config route handler.
 *
 * Mocks `setSlackChannelConfig` to observe which arguments the handler
 * forwards from the request body — particularly the optional `userToken` field.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import type { SlackChannelConfigResult } from "../../../../../daemon/handlers/config-slack-channel.js";

// ---------------------------------------------------------------------------
// Module mock — must appear before importing the module under test
// ---------------------------------------------------------------------------

interface SetConfigCall {
  botToken?: string;
  appToken?: string;
  userToken?: string;
}

let lastSetConfigCall: SetConfigCall | null = null;
let mockSetConfigResult: SlackChannelConfigResult = {
  success: true,
  hasBotToken: false,
  hasAppToken: false,
  hasUserToken: false,
  connected: false,
};

mock.module("../../../../../daemon/handlers/config-slack-channel.js", () => ({
  setSlackChannelConfig: async (
    botToken?: string,
    appToken?: string,
    userToken?: string,
  ): Promise<SlackChannelConfigResult> => {
    lastSetConfigCall = { botToken, appToken, userToken };
    return mockSetConfigResult;
  },
  getSlackChannelConfig: async (): Promise<SlackChannelConfigResult> => ({
    success: true,
    hasBotToken: false,
    hasAppToken: false,
    hasUserToken: false,
    connected: false,
  }),
  clearSlackChannelConfig: async (): Promise<SlackChannelConfigResult> => ({
    success: true,
    hasBotToken: false,
    hasAppToken: false,
    hasUserToken: false,
    connected: false,
  }),
}));

import { BadRequestError } from "../../../errors.js";
const { handleSetSlackChannelConfig } = await import("../channel.js");

describe("POST /v1/integrations/slack/channel/config", () => {
  afterEach(() => {
    lastSetConfigCall = null;
    mockSetConfigResult = {
      success: true,
      hasBotToken: false,
      hasAppToken: false,
      hasUserToken: false,
      connected: false,
    };
  });

  test("forwards userToken from request body as the third argument", async () => {
    const result = await handleSetSlackChannelConfig({
      body: { userToken: "xoxp-test-user-token" },
    });
    expect(result).toHaveProperty("success", true);

    expect(lastSetConfigCall).not.toBeNull();
    expect(lastSetConfigCall?.botToken).toBeUndefined();
    expect(lastSetConfigCall?.appToken).toBeUndefined();
    expect(lastSetConfigCall?.userToken).toBe("xoxp-test-user-token");
  });

  test("forwards all three tokens when present in body", async () => {
    const result = await handleSetSlackChannelConfig({
      body: {
        botToken: "xoxb-bot",
        appToken: "xapp-app",
        userToken: "xoxp-user",
      },
    });
    expect(result).toHaveProperty("success", true);

    expect(lastSetConfigCall?.botToken).toBe("xoxb-bot");
    expect(lastSetConfigCall?.appToken).toBe("xapp-app");
    expect(lastSetConfigCall?.userToken).toBe("xoxp-user");
  });

  test("leaves userToken undefined when absent from body", async () => {
    const result = await handleSetSlackChannelConfig({
      body: { botToken: "xoxb-bot", appToken: "xapp-app" },
    });
    expect(result).toHaveProperty("success", true);

    expect(lastSetConfigCall?.botToken).toBe("xoxb-bot");
    expect(lastSetConfigCall?.appToken).toBe("xapp-app");
    expect(lastSetConfigCall?.userToken).toBeUndefined();
  });

  test("throws BadRequestError when handler reports success: false", async () => {
    mockSetConfigResult = {
      success: false,
      hasBotToken: false,
      hasAppToken: false,
      hasUserToken: false,
      connected: false,
      error: 'Invalid user token: must start with "xoxp-"',
    };

    expect(
      handleSetSlackChannelConfig({ body: { userToken: "abc-123" } }),
    ).rejects.toThrow(BadRequestError);
    // Wait for promise to settle before checking call
    try {
      await handleSetSlackChannelConfig({ body: { userToken: "abc-123" } });
    } catch {
      // expected
    }
    expect(lastSetConfigCall?.userToken).toBe("abc-123");
  });
});
