import { describe, expect, it } from "bun:test";

import { isTranscriptOnScreen } from "@/domains/chat/utils/transcript-visibility";
import type { MainView } from "@/stores/viewer-store";

const CHAT_ROUTE = "/assistant/conversations/conv-1";

function onScreen(
  overrides: Partial<Parameters<typeof isTranscriptOnScreen>[0]> = {},
): boolean {
  return isTranscriptOnScreen({
    pathname: CHAT_ROUTE,
    mainView: "chat",
    isAppMinimized: false,
    isNarrow: false,
    ...overrides,
  });
}

describe("isTranscriptOnScreen", () => {
  it("is on screen on a conversation route with nothing over it", () => {
    expect(onScreen()).toBe(true);
    expect(onScreen({ pathname: "/assistant" })).toBe(true);
  });

  it("is off screen anywhere the layout puts something else in its place", () => {
    for (const pathname of [
      "/assistant/library",
      "/assistant/identity",
      "/assistant/home",
      "/assistant/settings/general",
      // A conversation subroute: the inspector renders instead of the
      // transcript, not beside it.
      "/assistant/conversations/conv-1/inspect",
    ]) {
      expect(onScreen({ pathname })).toBe(false);
    }
  });

  it("is off screen behind a full-width app", () => {
    expect(onScreen({ mainView: "app" })).toBe(false);
  });

  it("is on screen with the app parked to its strip, which it can be read behind", () => {
    expect(onScreen({ mainView: "app", isAppMinimized: true })).toBe(true);
    expect(
      onScreen({ mainView: "app", isAppMinimized: true, isNarrow: true }),
    ).toBe(true);
  });

  it("is on screen beside an app in the side-by-side layout", () => {
    expect(onScreen({ mainView: "app-editing" })).toBe(true);
  });

  it("keeps the chat mounted behind a drawer, and loses it behind an overlay", () => {
    // The same views are a drawer beside the chat on a wide viewport and a
    // full-screen portal on a narrow one.
    const overlays: readonly MainView[] = [
      "document",
      "tool-detail",
      "activity-steps",
      "message-files",
      "workflow-detail",
      "acp-run-detail",
      "background-task-detail",
      "skill-detail",
      "channel-setup",
      "subagent-detail",
    ];
    for (const mainView of overlays) {
      expect(onScreen({ mainView, isNarrow: false })).toBe(true);
      expect(onScreen({ mainView, isNarrow: true })).toBe(false);
    }
  });
});
