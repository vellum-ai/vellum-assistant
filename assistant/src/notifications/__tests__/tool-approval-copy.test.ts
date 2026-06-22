import { describe, expect, test } from "bun:test";

import { buildToolApprovalCardView } from "../tool-approval-copy.js";

/**
 * Pins the shared tool-approval view model: the assistant-as-actor copy, the
 * three connective branches (channel message / DM / no inbound), the
 * exact-message permalink, and the one-line sentence reused by Telegram / CLI.
 */
describe("buildToolApprovalCardView", () => {
  const channelMessage = {
    toolName: "web_fetch",
    requesterIdentifier: "Noa Flaherty",
    sourceChannel: "slack",
    conversationExternalId: "C01ABC",
    channelName: "general",
    messageTs: "1700000000.000100",
    messagePreview: "can you pull this? https://example.com/article",
    commandPreview: "GET https://example.com/article",
    requestId: "req-1",
  };

  test("titleLine names the tool, not the contact (assistant-as-actor)", () => {
    const view = buildToolApprovalCardView(channelMessage);
    expect(view.titleLine).toBe('Assistant wants to use "web_fetch"');
    expect(view.titleLine).not.toContain("Noa");
  });

  test("channel message: connective names the sender + channel", () => {
    const view = buildToolApprovalCardView(channelMessage);
    expect(view.connectiveLine).toBe(
      "in response to Noa Flaherty's message in #general",
    );
    expect(view.sentence).toBe(
      'Assistant wants to use "web_fetch" in response to Noa Flaherty\'s message in #general.',
    );
  });

  test("channel message: exact-message permalink from channel id + ts", () => {
    const view = buildToolApprovalCardView(channelMessage);
    expect(view.messagePermalink).toBe(
      "https://slack.com/archives/C01ABC/p1700000000000100",
    );
  });

  test("channel name falls back to the channel id when absent", () => {
    const view = buildToolApprovalCardView({
      ...channelMessage,
      channelName: undefined,
    });
    expect(view.connectiveLine).toBe(
      "in response to Noa Flaherty's message in #C01ABC",
    );
  });

  test("DM: connective drops the channel and no permalink without ts", () => {
    const view = buildToolApprovalCardView({
      ...channelMessage,
      conversationExternalId: "D01XYZ",
      channelName: undefined,
      messageTs: undefined,
    });
    expect(view.isSlackDm).toBe(true);
    expect(view.connectiveLine).toBe("in response to Noa Flaherty's message");
    expect(view.messagePermalink).toBeUndefined();
  });

  test("non-slack channel: connective without '#channel', no permalink", () => {
    const view = buildToolApprovalCardView({
      toolName: "web_search",
      requesterIdentifier: "Alice",
      sourceChannel: "telegram",
      messagePreview: "search the news",
      requestId: "req-2",
    });
    expect(view.connectiveLine).toBe("in response to Alice's message");
    expect(view.messagePermalink).toBeUndefined();
  });

  test("no inbound trigger (no requester): connective omitted", () => {
    const view = buildToolApprovalCardView({
      toolName: "bash",
      sourceChannel: "slack",
      requestId: "req-3",
    });
    expect(view.connectiveLine).toBeUndefined();
    expect(view.sentence).toBe('Assistant wants to use "bash".');
  });

  test("voice (phone) has a caller but no 'message' connective", () => {
    const view = buildToolApprovalCardView({
      toolName: "bash",
      requesterIdentifier: "Bob",
      sourceChannel: "phone",
      requestId: "req-4",
    });
    expect(view.connectiveLine).toBeUndefined();
  });

  test("preview and command are sanitized / passed through", () => {
    const view = buildToolApprovalCardView(channelMessage);
    expect(view.messagePreview).toBe(
      "can you pull this? https://example.com/article",
    );
    expect(view.commandPreview).toBe("GET https://example.com/article");
  });

  test("falls back to a placeholder tool name when missing", () => {
    const view = buildToolApprovalCardView({ requestId: "req-5" });
    expect(view.titleLine).toBe('Assistant wants to use "unknown tool"');
  });
});
