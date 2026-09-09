/**
 * Tests for `AssistantSleepStage`, the full-page sleeping/waking takeover.
 *
 * What decides whether it draws: the route, the assistant's phase, whether the
 * sleep is one the user arrived into (a page load or a return to the tab)
 * rather than one that began under them, and whether they have clicked it away
 * this sleep. Plus the waking outro, which plays only for a sleep the stage
 * actually showed. Those are what it gets wrong if it gets anything wrong, so
 * they are what is covered here.
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

import { getCharacterComponents } from "@vellumai/avatar-catalog";

import type { AssistantSleepPhase } from "@/components/status-banner";

let phaseMock: AssistantSleepPhase | null = "waking";
let voiceRoomVisibleMock = false;

mock.module("@/components/status-banner", () => ({
  useAssistantSleepPhase: () => phaseMock,
}));

let avatarMock: {
  components: unknown;
  traits: { bodyShape: string; eyeStyle: string; color: string } | null;
  customImageUrl: string | null;
} = { components: null, traits: null, customImageUrl: null };

mock.module("@/hooks/use-assistant-avatar", () => ({
  useAssistantAvatar: () => avatarMock,
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

const { AssistantSleepStage, __setArrivalWindowMsForTesting } =
  await import("@/domains/chat/components/assistant-sleep-stage");
const { publish, __resetForTesting: resetEventBus } =
  await import("@/lib/event-bus");
const { useAssistantIdentityStore } =
  await import("@/stores/assistant-identity-store");
const { useAssistantSleepStageStore } =
  await import("@/stores/assistant-sleep-stage-store");
const { useResolvedAssistantsStore } =
  await import("@/stores/resolved-assistants-store");

/** The stage's one control: its surface is inert. */
function closeButton() {
  return screen.getByRole("button", { name: "Hide the sleep screen" });
}

function renderAt(pathname: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // A fresh element each time: React bails out of re-rendering a referentially
  // identical one, and the point of a repoll is to read `phaseMock` again.
  const tree = () => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[pathname]}>
        <AssistantSleepStage />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(tree());
  return { ...view, repoll: () => view.rerender(tree()) };
}

beforeEach(() => {
  phaseMock = "waking";
  voiceRoomVisibleMock = false;
  avatarMock = { components: null, traits: null, customImageUrl: null };
  useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-1" });
  useAssistantIdentityStore.setState({ name: "Mel", version: null });
  useAssistantSleepStageStore.setState({
    visible: false,
    dismissed: false,
    dismissedAssistantId: null,
    forcedScene: null,
  });
  __setArrivalWindowMsForTesting(20_000);
  resetEventBus();
});

afterEach(cleanup);

describe("AssistantSleepStage", () => {
  test("names the waking assistant on the conversation page", () => {
    renderAt("/assistant/conversations/c1");

    expect(screen.getByText("Mel is waking up…")).toBeTruthy();
    expect(useAssistantSleepStageStore.getState().visible).toBe(true);
  });

  test("draws the assistant's own eyes, and none when no traits are known", () => {
    const { container, unmount } = renderAt("/assistant/conversations/c1");
    // Nothing known: the catalog's first creature is not this assistant, so
    // the stage is the line of copy alone.
    expect(container.querySelector("[data-slot=sleep-stage-eyes]")).toBeNull();
    unmount();

    const catalog = getCharacterComponents();
    avatarMock = {
      components: catalog,
      traits: {
        bodyShape: catalog.bodyShapes[1]!.id,
        eyeStyle: catalog.eyeStyles[1]!.id,
        color: catalog.colors[1]!.id,
      },
      customImageUrl: null,
    };

    const view = renderAt("/assistant/conversations/c1");
    const svg = view.container.querySelector("[data-slot=sleep-stage-eyes]");
    expect(svg).not.toBeNull();
    // The lid is the avatar's own color, clipped to the eyes' silhouette.
    expect(svg!.querySelector("clipPath")).not.toBeNull();
    expect(svg!.querySelector("rect")?.getAttribute("fill")).toBe(
      catalog.colors[1]!.hex,
    );
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

    fireEvent.click(closeButton());

    expect(screen.queryByText("Mel is waking up…")).toBeNull();
    expect(useAssistantSleepStageStore.getState().visible).toBe(false);
    expect(useAssistantSleepStageStore.getState().dismissed).toBe(true);
  });

  test("a dismissal survives a remount of the same assistant's stage", () => {
    const view = renderAt("/assistant/conversations/c1");
    fireEvent.click(closeButton());
    view.unmount();

    // What a window crossing the mobile breakpoint does: `ChatLayout` moves
    // the stage between its branches, remounting it on the same assistant.
    renderAt("/assistant/conversations/c1");

    expect(screen.queryByText("Mel is waking up…")).toBeNull();
  });

  test("the dismissal lasts only as long as the sleep it was aimed at", () => {
    useAssistantSleepStageStore.setState({
      dismissed: true,
      dismissedAssistantId: "assistant-1",
    });
    phaseMock = null;

    const view = renderAt("/assistant/conversations/c1");
    expect(useAssistantSleepStageStore.getState().dismissed).toBe(false);

    view.unmount();
    phaseMock = "sleeping";
    renderAt("/assistant/conversations/c1");

    expect(screen.getByText("Mel is asleep")).toBeTruthy();
  });

  test("a click on the stage itself does not dismiss it", () => {
    renderAt("/assistant/conversations/c1");

    fireEvent.click(screen.getByText("Mel is waking up…"));

    expect(screen.getByText("Mel is waking up…")).toBeTruthy();
    expect(useAssistantSleepStageStore.getState().dismissed).toBe(false);
  });

  test("leaves a sleep that begins mid-session to the banner", () => {
    // The user has been working in this tab; nothing about that is an
    // arrival, so a drop-out mid-session is the banner's to report.
    __setArrivalWindowMsForTesting(-1);
    phaseMock = null;
    const view = renderAt("/assistant/conversations/c1");

    phaseMock = "sleeping";
    view.repoll();

    expect(screen.queryByText("Mel is asleep")).toBeNull();
    expect(useAssistantSleepStageStore.getState().visible).toBe(false);
  });

  test("coming back to the tab arms it, the network coming back does not", () => {
    __setArrivalWindowMsForTesting(-1);
    phaseMock = null;
    const view = renderAt("/assistant/conversations/c1");
    phaseMock = "sleeping";
    view.repoll();

    act(() => publish("app.resume", { signal: "online" }));
    expect(screen.queryByText("Mel is asleep")).toBeNull();

    act(() => publish("app.resume", { signal: "visibility" }));
    expect(screen.getByText("Mel is asleep")).toBeTruthy();
  });

  test("plays the waking outro for a sleep it showed", () => {
    const view = renderAt("/assistant/conversations/c1");
    expect(screen.getByText("Mel is waking up…")).toBeTruthy();

    phaseMock = null;
    view.repoll();

    expect(screen.getByText("Mel just woke up")).toBeTruthy();
    expect(useAssistantSleepStageStore.getState().visible).toBe(true);
  });

  test("does not announce a waking it never showed asleep", () => {
    __setArrivalWindowMsForTesting(-1);
    phaseMock = null;
    const view = renderAt("/assistant/conversations/c1");
    phaseMock = "waking";
    view.repoll();
    phaseMock = null;
    view.repoll();

    expect(screen.queryByText("Mel just woke up")).toBeNull();
  });

  test("the dev override pins a scene with no sleep at all, and a click clears it", () => {
    phaseMock = null;
    useAssistantSleepStageStore.setState({ forcedScene: "sleeping" });

    renderAt("/assistant/conversations/c1");
    expect(screen.getByText("Mel is asleep")).toBeTruthy();

    fireEvent.click(closeButton());

    expect(screen.queryByText("Mel is asleep")).toBeNull();
    expect(useAssistantSleepStageStore.getState().forcedScene).toBeNull();
  });

  test("a dismissal does not carry over to another sleeping assistant", () => {
    renderAt("/assistant/conversations/c1");
    fireEvent.click(closeButton());
    expect(screen.queryByText("Mel is waking up…")).toBeNull();

    act(() => {
      useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-2" });
    });

    // The dismissal was aimed at the assistant that was asleep, not at the
    // stage: the one switched to gets its own.
    expect(screen.getByText("Mel is waking up…")).toBeTruthy();
    expect(useAssistantSleepStageStore.getState().visible).toBe(true);
  });
});
