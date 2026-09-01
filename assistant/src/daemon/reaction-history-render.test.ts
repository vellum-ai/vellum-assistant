import { describe, expect, test } from "bun:test";

import type { ProviderMessageMetadata } from "../messaging/provider-message-metadata.js";
import { renderReactionHistoryText } from "./reaction-history-render.js";

function reactionMeta(
  overrides: Omit<Partial<ProviderMessageMetadata>, "reaction"> & {
    reaction?: Partial<NonNullable<ProviderMessageMetadata["reaction"]>>;
  } = {},
): ProviderMessageMetadata {
  const { reaction, ...rest } = overrides;
  return {
    source: "slack",
    conversationExternalId: "C123",
    eventKind: "reaction",
    reaction: {
      targetMessageId: "1716000000.000001",
      emoji: "thumbsup",
      op: "added",
      actorDisplayName: "Alice",
      ...reaction,
    },
    ...rest,
  } as ProviderMessageMetadata;
}

const noTarget = () => undefined;

describe("renderReactionHistoryText", () => {
  test("renders an added reaction with the quoted target", () => {
    const rendered = renderReactionHistoryText(
      reactionMeta(),
      () => "Deploy is done",
    );
    expect(rendered).toContain(
      'Alice reacted with :thumbsup: to the message "Deploy is done"',
    );
  });

  test("renders a removed reaction", () => {
    const rendered = renderReactionHistoryText(
      reactionMeta({ reaction: { op: "removed" } }),
      noTarget,
    );
    expect(rendered).toContain(
      "Alice removed their :thumbsup: reaction from an earlier message",
    );
  });

  test("fences the line as untrusted channel content", () => {
    const rendered = renderReactionHistoryText(
      reactionMeta({ actorExternalId: "U123" }),
      noTarget,
    );
    expect(rendered).toContain('<external_content source="slack"');
    expect(rendered).toContain('origin="U123"');
    expect(rendered).toContain("</external_content>");
  });

  test("non-slack channels fence with the webhook source", () => {
    const rendered = renderReactionHistoryText(
      reactionMeta({ source: "discord" }),
      noTarget,
    );
    expect(rendered).toContain('<external_content source="webhook"');
  });

  test("keeps a Discord custom-emoji mention form as-is", () => {
    const rendered = renderReactionHistoryText(
      reactionMeta({ reaction: { emoji: "<:vex:12345>" } }),
      noTarget,
    );
    expect(rendered).toContain("reacted with <:vex:12345> to");
  });

  test("keeps a unicode emoji as-is", () => {
    const rendered = renderReactionHistoryText(
      reactionMeta({ reaction: { emoji: "👍" } }),
      noTarget,
    );
    expect(rendered).toContain("reacted with 👍 to");
  });

  test("strips ingress fences and collapses whitespace in the quote", () => {
    const rendered = renderReactionHistoryText(
      reactionMeta(),
      () =>
        '<external_content source="slack">\nline one\n  line two\n</external_content>',
    );
    expect(rendered).toContain('the message "line one line two"');
  });

  test("truncates a long quoted target", () => {
    const rendered = renderReactionHistoryText(reactionMeta(), () =>
      "x".repeat(500),
    );
    expect(rendered).toContain(`"${"x".repeat(120)}..."`);
    expect(rendered).not.toContain("x".repeat(121));
  });

  test("falls back to Someone when no display name is stored", () => {
    const rendered = renderReactionHistoryText(
      reactionMeta({ reaction: { actorDisplayName: undefined } }),
      noTarget,
    );
    expect(rendered).toContain("Someone reacted with");
  });

  test("prefers the row-level display name over the fallback", () => {
    const rendered = renderReactionHistoryText(
      reactionMeta({
        displayName: "Bob",
        reaction: { actorDisplayName: undefined },
      }),
      noTarget,
    );
    expect(rendered).toContain("Bob reacted with");
  });

  test("a self-authored row is second-person with the quoted target fenced", () => {
    const rendered = renderReactionHistoryText(
      reactionMeta({ source: "discord" }),
      () => "Deploy is done",
      { selfAuthored: true },
    );
    expect(rendered).toContain("You reacted with :thumbsup: to this message:");
    expect(rendered).toContain('<external_content source="webhook"');
    expect(rendered).toContain("Deploy is done");
    expect(rendered).toContain("</external_content>");
  });

  test("a self-authored row with no target stays unfenced", () => {
    const rendered = renderReactionHistoryText(
      reactionMeta({ source: "discord" }),
      noTarget,
      { selfAuthored: true },
    );
    expect(rendered).toBe("You reacted with :thumbsup: to an earlier message");
    expect(rendered).not.toContain("<external_content");
  });

  test("a self-authored removal reads as your reaction", () => {
    const rendered = renderReactionHistoryText(
      reactionMeta({ reaction: { op: "removed" } }),
      noTarget,
      { selfAuthored: true },
    );
    expect(rendered).toContain(
      "You removed your :thumbsup: reaction from an earlier message",
    );
  });

  test("returns null for a message row", () => {
    const meta: ProviderMessageMetadata = {
      source: "slack",
      conversationExternalId: "C123",
      messageId: "1716000000.000001",
      eventKind: "message",
    } as ProviderMessageMetadata;
    expect(renderReactionHistoryText(meta, noTarget)).toBeNull();
  });
});
