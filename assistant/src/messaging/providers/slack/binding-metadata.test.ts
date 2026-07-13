import { beforeEach, describe, expect, test } from "bun:test";

import { setConfig } from "../../../__tests__/helpers/set-config.js";
import type { ExternalConversationBinding } from "../../../persistence/external-conversation-store.js";

// Seed the Slack workspace identity that the deep-link builders read. An
// empty `teamUrl` (schema default) makes the URL builders return undefined,
// standing in for the "no slack config" case.
function seedSlack(
  overrides: { teamId?: string; teamUrl?: string } = {},
): void {
  setConfig("slack", {
    teamId: "T0EXAMPLE",
    teamUrl: "https://example-workspace.slack.com",
    ...overrides,
  });
}

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
  beforeEach(() => {
    seedSlack();
  });

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
    // An empty teamUrl is the schema default — the URL builders return
    // undefined, so no source link is produced.
    seedSlack({ teamUrl: "" });
    const metadata = buildSlackBindingMetadata(makeBinding({}));
    expect(metadata.sourceLink).toBeUndefined();
  });
});
