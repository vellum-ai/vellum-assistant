/**
 * Tests for `AssistantSleepStage`, the full-page sleeping/waking takeover.
 *
 * Three things decide whether it draws (the route, the assistant's phase, and
 * whether the user has clicked it away this sleep), and the status banner reads
 * the store it publishes to. Those are what the stage gets wrong if it gets
 * anything wrong, so they are what is covered here.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

import type { AssistantSleepPhase } from "@/components/status-banner";

let phaseMock: AssistantSleepPhase | null = "waking";
let voiceRoomVisibleMock = false;

mock.module("@/components/status-banner", () => ({
  useAssistantSleepPhase: () => phaseMock,
}));

mock.module("@/hooks/use-assistant-avatar", () => ({
  useAssistantAvatar: () => ({
    components: null,
    traits: null,
    customImageUrl: null,
  }),
}));

mock.module(
  "@/domains/chat/voice/voice-room/use-is-voice-room-visible",
  () => ({
    useIsVoiceRoomVisible: () => voiceRoomVisibleMock,
  }),
);

mock.module("@/lib/avatar-last-seen-cache", () => ({
  readLastSeenAvatar: async () => null,
}));

const { AssistantSleepStage } =
  await import("@/domains/chat/components/assistant-sleep-stage");
const { useAssistantIdentityStore } =
  await import("@/stores/assistant-identity-store");
const { useAssistantSleepStageStore } =
  await import("@/stores/assistant-sleep-stage-store");
const { useResolvedAssistantsStore } =
  await import("@/stores/resolved-assistants-store");

function renderAt(pathname: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[pathname]}>
        <AssistantSleepStage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  phaseMock = "waking";
  voiceRoomVisibleMock = false;
  useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-1" });
  useAssistantIdentityStore.setState({ name: "Mel", version: null });
  useAssistantSleepStageStore.setState({ visible: false, dismissed: false });
});

afterEach(cleanup);

describe("AssistantSleepStage", () => {
  test("names the waking assistant on the conversation page", () => {
    renderAt("/assistant/conversations/c1");

    expect(screen.getByText("Mel is waking up…")).toBeTruthy();
    expect(useAssistantSleepStageStore.getState().visible).toBe(true);
  });

  test("falls back to unnamed copy before the identity resolves", () => {
    useAssistantIdentityStore.setState({ name: null, version: null });

    renderAt("/assistant/conversations/c1");

    expect(screen.getByText("Your assistant is waking up…")).toBeTruthy();
  });

  test("covers the draft conversation at the assistant index too", () => {
    renderAt("/assistant");

    expect(screen.getByText("Mel is waking up…")).toBeTruthy();
  });

  test("stays off routes that mount no chat surface", () => {
    for (const path of [
      "/assistant/home",
      "/assistant/conversations/c1/inspect",
    ]) {
      const view = renderAt(path);
      expect(screen.queryByText("Mel is waking up…")).toBeNull();
      expect(useAssistantSleepStageStore.getState().visible).toBe(false);
      view.unmount();
    }
  });

  test("leaves the surface to the voice room", () => {
    voiceRoomVisibleMock = true;

    renderAt("/assistant/conversations/c1");

    expect(screen.queryByText("Mel is waking up…")).toBeNull();
    expect(useAssistantSleepStageStore.getState().visible).toBe(false);
  });

  test("a click hands the status back to the banner", () => {
    renderAt("/assistant/conversations/c1");

    fireEvent.click(screen.getByText("Mel is waking up…"));

    expect(screen.queryByText("Mel is waking up…")).toBeNull();
    expect(useAssistantSleepStageStore.getState().visible).toBe(false);
    expect(useAssistantSleepStageStore.getState().dismissed).toBe(true);
  });

  test("the dismissal lasts only as long as the sleep it was aimed at", () => {
    useAssistantSleepStageStore.setState({ dismissed: true });
    phaseMock = null;

    const view = renderAt("/assistant/conversations/c1");
    expect(useAssistantSleepStageStore.getState().dismissed).toBe(false);

    view.unmount();
    phaseMock = "sleeping";
    renderAt("/assistant/conversations/c1");

    expect(screen.getByText("Mel is asleep")).toBeTruthy();
  });

  test("a dismissal does not carry over to another sleeping assistant", () => {
    renderAt("/assistant/conversations/c1");
    fireEvent.click(screen.getByText("Mel is waking up…"));
    expect(screen.queryByText("Mel is waking up…")).toBeNull();

    act(() => {
      useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-2" });
    });

    expect(useAssistantSleepStageStore.getState().dismissed).toBe(false);
    expect(screen.getByText("Mel is waking up…")).toBeTruthy();
  });
});
