import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import type { AssistantEventEnvelope } from "@vellumai/assistant-api";

import { __resetForTesting, publish } from "@/lib/event-bus";

const handleScreenRecordingEvent = mock(async () => undefined);
mock.module("@/runtime/screen-recording", () => ({
  handleScreenRecordingEvent,
}));

const { useScreenRecordingLifecycle } =
  await import("./use-screen-recording-lifecycle");

function RootSubscriber({ route }: { route: "chat" | "settings" }) {
  useScreenRecordingLifecycle("assistant-1");
  return route === "chat" ? <ChatRoute /> : <div>settings</div>;
}

function ChatRoute() {
  return <div>chat</div>;
}

function publishRecordingStop(): void {
  publish("sse.event", {
    id: "evt-1",
    emittedAt: new Date().toISOString(),
    message: {
      type: "recording_stop",
      recordingId: "00000000-0000-4000-8000-000000000001",
    },
  } as AssistantEventEnvelope);
}

beforeEach(() => {
  __resetForTesting();
  handleScreenRecordingEvent.mockClear();
});

afterEach(() => {
  cleanup();
  __resetForTesting();
});

test("handles recording events after the chat route unmounts", () => {
  const view = render(<RootSubscriber route="chat" />);

  view.rerender(<RootSubscriber route="settings" />);
  act(() => publishRecordingStop());

  expect(handleScreenRecordingEvent).toHaveBeenCalledWith(
    {
      type: "recording_stop",
      recordingId: "00000000-0000-4000-8000-000000000001",
    },
    "assistant-1",
  );
});
