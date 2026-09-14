import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import type * as CreditsUpsell from "@/domains/chat/components/credits-upsell-card";
import type { DisplayMessage } from "@/domains/chat/types/types";
import { textBody } from "@/domains/chat/utils/message-test-helpers";

mock.module(
  "@/domains/chat/components/credits-upsell-card",
  (): Partial<typeof CreditsUpsell> => ({
    CreditsUpsellCard: () => <div data-testid="credits-upsell" />,
  }),
);

import { buildTranscriptItems } from "./build-items";
import { TranscriptRow } from "./transcript-row";

afterEach(cleanup);

const frames: DisplayMessage[] = ["f1", "f2", "f3"].map((id) => ({
  id,
  role: "user",
  isCameraFrame: true,
  ...textBody("(camera frame)"),
}));
const utterance: DisplayMessage = {
  id: "speech",
  role: "user",
  ...textBody("What is this?"),
};

function renderProjection(
  messages: DisplayMessage[],
  creditsExhausted = false,
) {
  const items = buildTranscriptItems({
    messages,
    creditsExhausted,
    pendingSecret: null,
    pendingConfirmation: null,
    isThinking: false,
  });
  return render(
    <>
      {items.map((item) => (
        <TranscriptRow key={item.key} item={item} onSurfaceAction={() => {}} />
      ))}
    </>,
  );
}

function expectEveryTile(container: HTMLElement) {
  expect(container.querySelectorAll('[role="img"]')).toHaveLength(
    frames.length,
  );
  for (const frame of frames) {
    const matches = container.querySelectorAll(`#msg-${frame.id}`);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.querySelector('[role="img"]')).toBeTruthy();
  }
  const first = container.querySelector("#msg-f1")!;
  const second = container.querySelector("#msg-f2")!;
  const third = container.querySelector("#msg-f3")!;
  expect(
    first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    second.compareDocumentPosition(third) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(container.textContent).not.toContain("(camera frame)");
}

describe("camera frame projection through TranscriptRow", () => {
  test("a standalone projected run renders every tile once", () => {
    const { container } = renderProjection(frames);
    expectEveryTile(container);
  });

  test.each([
    { name: "deleted user", props: { deletedAt: 0 } },
    {
      name: "reaction",
      props: {
        reaction: { emoji: "🎉", op: "added", targetMessageId: "target-123" },
      },
    },
    { name: "system card", props: { isSystemCard: true } },
    { name: "silent user", props: { isNoResponse: true } },
    {
      name: "Slack reaction",
      props: {
        slackMessage: {
          channelId: "channel-123",
          channelTs: "1",
          eventKind: "reaction",
          reaction: { emoji: "🎉", op: "added", targetChannelTs: "0" },
        },
      },
    },
    {
      name: "credits substitution",
      props: { providerError: { category: "credits_exhausted" } },
    },
    { name: "assistant", props: { role: "assistant" } },
  ] satisfies { name: string; props: Partial<DisplayMessage> }[])(
    "keeps every frame visible around $name",
    ({ props }) => {
      const special: DisplayMessage = {
        id: "special",
        role: "user",
        isCameraFrame: true,
        ...textBody("Status"),
        ...props,
      };
      const { container, getByText } = renderProjection(
        [frames[0]!, frames[1]!, special, frames[2]!, utterance],
        Boolean(special.providerError),
      );
      expectEveryTile(container);
      expect(
        getByText("What is this?")
          .closest(".rounded-lg")!
          .contains(container.querySelector("#msg-f3")),
      ).toBe(true);
    },
  );

  test("hidden notifications and queued rows leave one visible utterance group", () => {
    const hidden: DisplayMessage[] = [
      { id: "hidden-subagent", role: "user", isSubagentNotification: true },
      { id: "hidden-acp", role: "user", isAcpNotification: true },
      {
        id: "hidden-background",
        role: "user",
        isBackgroundEventNotification: true,
      },
      { id: "hidden-queued", role: "user", queueStatus: "queued" },
    ];
    const { container, getByText } = renderProjection([
      frames[0]!,
      ...hidden,
      ...frames.slice(1),
      utterance,
    ]);
    expectEveryTile(container);
    const bubble = getByText("What is this?").closest(".rounded-lg")!;
    for (const frame of frames) {
      expect(bubble.contains(container.querySelector(`#msg-${frame.id}`))).toBe(
        true,
      );
    }
    for (const message of hidden) {
      expect(container.querySelector(`#msg-${message.id}`)).toBeNull();
    }
  });
});
