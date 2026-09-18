import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import { toolCallStatusWireFields } from "@/domains/chat/utils/message-test-helpers";

const sdkStub = async () => ({ data: undefined });
const realSdkPath = new URL(
  "../../../generated/daemon/sdk.gen.ts",
  import.meta.url,
).pathname;
const sdkSource = await Bun.file(realSdkPath).text();
const exportNames = [...sdkSource.matchAll(/^export const (\w+)/gm)].map(
  (match) => match[1]!,
);
mock.module("@/generated/daemon/sdk.gen", () =>
  Object.fromEntries(exportNames.map((name) => [name, sdkStub])),
);

const { MobileActivityStepsOverlay } =
  await import("@/domains/chat/components/mobile-activity-steps-overlay");

afterEach(cleanup);

function screenshotCall(id: string, data: string): ChatMessageToolCall {
  return {
    id,
    name: "computer_use_screenshot",
    input: { activity: `Checking ${id}` },
    imageDataList: [data],
    ...toolCallStatusWireFields("completed"),
  };
}

test("preview swipe and Escape leave the mobile steps overlay open", async () => {
  const calls = [
    screenshotCall("first", "AAAA"),
    screenshotCall("second", "BBBB"),
  ];
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MobileActivityStepsOverlay
        payload={{
          items: calls.map((toolCall) => ({ kind: "toolCall", toolCall })),
          toolCalls: calls,
        }}
        assistantId="asst-1"
        onClose={() => {}}
      />
    </QueryClientProvider>,
  );

  const tile = await screen.findByRole(
    "button",
    { name: "Preview screenshot from Checking second" },
    { timeout: 5_000 },
  );
  fireEvent.click(tile);
  const dialog = screen.getByRole("dialog", { name: /Preview/ });
  expect(screen.getByText("2 / 2")).toBeTruthy();

  const swipeTarget = dialog.querySelector<HTMLElement>(
    '[style*="touch-action"]',
  )!;
  fireEvent.touchStart(swipeTarget, {
    touches: [{ identifier: 1, clientX: 200, clientY: 100 }],
    changedTouches: [{ identifier: 1, clientX: 200, clientY: 100 }],
  });
  fireEvent.touchMove(swipeTarget, {
    touches: [{ identifier: 1, clientX: 300, clientY: 100 }],
    changedTouches: [{ identifier: 1, clientX: 300, clientY: 100 }],
  });
  fireEvent.touchEnd(swipeTarget, {
    touches: [],
    changedTouches: [{ identifier: 1, clientX: 300, clientY: 100 }],
  });
  expect(screen.getByText("1 / 2")).toBeTruthy();

  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: /Preview/ })).toBeNull();
  expect(screen.getByRole("dialog", { name: "Activity details" })).toBeTruthy();
  expect(screen.getByTestId("mobile-activity-steps-overlay")).toBeTruthy();
  expect(screen.getByLabelText("Close steps")).toBeTruthy();
});
