import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import {
  __resetForTesting,
  publish,
  type SourcedAssistantEventEnvelope,
} from "@/lib/event-bus";

const handleScreenRecordingEvent = mock(async () => undefined);
mock.module("@/runtime/screen-recording", () => ({
  handleScreenRecordingEvent,
}));

const { useScreenRecordingLifecycle } =
  await import("./use-screen-recording-lifecycle");

function RootSubscriber({
  route,
  selectedAssistantId = "assistant-1",
}: {
  route: "chat" | "settings";
  selectedAssistantId?: string;
}) {
  useScreenRecordingLifecycle();
  return route === "chat" ? (
    <ChatRoute />
  ) : (
    <div>{`settings:${selectedAssistantId}`}</div>
  );
}

function ChatRoute() {
  return <div>chat</div>;
}

function publishRecordingStop(): void {
  publish("sse.event", {
    id: "evt-1",
    emittedAt: new Date().toISOString(),
    sourceAssistantId: "assistant-1",
    message: {
      type: "recording_stop",
      recordingId: "00000000-0000-4000-8000-000000000001",
    },
  } as SourcedAssistantEventEnvelope);
}

beforeEach(() => {
  __resetForTesting();
  handleScreenRecordingEvent.mockClear();
});

test("routes a buffered event to its source assistant during a switch", () => {
  const view = render(
    <RootSubscriber route="chat" selectedAssistantId="assistant-old" />,
  );

  view.rerender(
    <RootSubscriber route="settings" selectedAssistantId="assistant-new" />,
  );
  act(() => {
    publish("sse.event", {
      id: "evt-old",
      emittedAt: new Date().toISOString(),
      sourceAssistantId: "assistant-old",
      message: {
        type: "recording_start",
        recordingId: "00000000-0000-4000-8000-000000000002",
        attachToConversationId: "conv-old",
      },
    } as SourcedAssistantEventEnvelope);
  });

  expect(handleScreenRecordingEvent).toHaveBeenCalledTimes(1);
  expect(handleScreenRecordingEvent).toHaveBeenCalledWith(
    expect.objectContaining({ recordingId: expect.any(String) }),
    "assistant-old",
  );
  expect(handleScreenRecordingEvent).not.toHaveBeenCalledWith(
    expect.anything(),
    "assistant-new",
  );
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
