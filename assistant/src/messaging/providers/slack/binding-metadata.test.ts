import { describe, expect, mock, test } from "bun:test";

import type { ExternalConversationBinding } from "../../../persistence/external-conversation-store.js";

const configRef: { slack: { teamId?: string; teamUrl?: string } | undefined } =
  {
    slack: {
      teamId: "T0EXAMPLE",
      teamUrl: "https://example-workspace.slack.com",
    },
  };
mock.module("../../../config/loader.js", () => ({
  getConfig: () => ({ slack: configRef.slack }),
}));

const { buildSlackBindingMetadata } = await import("./binding-metadata.js");

function makeBinding(
  overrides: Partial<ExternalConversationBinding>,
): ExternalConversationBinding {
  return {
    sourceChannel: "slack",
    externalChatId: "C0CHANNEL",
    externalUserId: null,
    displayName: null,
    username: null,
    ...overrides,
  } as ExternalConversationBinding;
}

describe("buildSlackBindingMetadata sourceLink", () => {
  test("prefers the bound thread's deep link", () => {
    const metadata = buildSlackBindingMetadata(
      makeBinding({ externalThreadId: "1720000000.000100" }),
    );

    expect(metadata.sourceLink).toBeDefined();
    expect(metadata.sourceLink).toEqual(metadata.slackThread?.link);
    expect(metadata.sourceLink?.webUrl).toContain("p1720000000000100");
  });

  test("falls back to the channel web link when no thread is bound", () => {
    const metadata = buildSlackBindingMetadata(makeBinding({}));

    expect(metadata.slackThread).toBeUndefined();
    expect(metadata.sourceLink).toEqual({
      webUrl: "https://example-workspace.slack.com/archives/C0CHANNEL",
    });
  });

  test("omits sourceLink entirely without slack config", () => {
    configRef.slack = undefined;
    try {
      const metadata = buildSlackBindingMetadata(makeBinding({}));
      expect(metadata.sourceLink).toBeUndefined();
    } finally {
      configRef.slack = {
        teamId: "T0EXAMPLE",
        teamUrl: "https://example-workspace.slack.com",
      };
    }
  });
});
