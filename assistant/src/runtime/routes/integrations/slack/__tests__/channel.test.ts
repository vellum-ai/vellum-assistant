/**
 * Unit tests for the POST /v1/integrations/slack/channel/config HTTP route.
 *
 * Mocks `setSlackChannelConfig` in the config-slack-channel handler module so
 * the test can observe which arguments the HTTP handler forwards from the
 * request body — particularly the optional `userToken` field.
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
    const req = new Request("http://localhost/v1/integrations/slack/channel/config", {
      method: "POST",
      body: JSON.stringify({ userToken: "xoxp-test-user-token" }),
    });

    const res = await handleSetSlackChannelConfig(req);
    expect(res.status).toBe(200);

    expect(lastSetConfigCall).not.toBeNull();
    expect(lastSetConfigCall?.botToken).toBeUndefined();
    expect(lastSetConfigCall?.appToken).toBeUndefined();
    expect(lastSetConfigCall?.userToken).toBe("xoxp-test-user-token");
  });

  test("forwards all three tokens when present in body", async () => {
    const req = new Request("http://localhost/v1/integrations/slack/channel/config", {
      method: "POST",
      body: JSON.stringify({
        botToken: "xoxb-bot",
        appToken: "xapp-app",
        userToken: "xoxp-user",
      }),
    });

    const res = await handleSetSlackChannelConfig(req);
    expect(res.status).toBe(200);

    expect(lastSetConfigCall?.botToken).toBe("xoxb-bot");
    expect(lastSetConfigCall?.appToken).toBe("xapp-app");
    expect(lastSetConfigCall?.userToken).toBe("xoxp-user");
  });

  test("leaves userToken undefined when absent from body", async () => {
    const req = new Request("http://localhost/v1/integrations/slack/channel/config", {
      method: "POST",
      body: JSON.stringify({ botToken: "xoxb-bot", appToken: "xapp-app" }),
    });

    const res = await handleSetSlackChannelConfig(req);
    expect(res.status).toBe(200);

    expect(lastSetConfigCall?.botToken).toBe("xoxb-bot");
    expect(lastSetConfigCall?.appToken).toBe("xapp-app");
    expect(lastSetConfigCall?.userToken).toBeUndefined();
  });

  test("returns 400 when handler reports success: false", async () => {
    mockSetConfigResult = {
      success: false,
      hasBotToken: false,
      hasAppToken: false,
      hasUserToken: false,
      connected: false,
      error: "Invalid user token: must start with \"xoxp-\"",
    };

    const req = new Request("http://localhost/v1/integrations/slack/channel/config", {
      method: "POST",
      body: JSON.stringify({ userToken: "abc-123" }),
    });

    const res = await handleSetSlackChannelConfig(req);
    expect(res.status).toBe(400);
    expect(lastSetConfigCall?.userToken).toBe("abc-123");
  });
});
