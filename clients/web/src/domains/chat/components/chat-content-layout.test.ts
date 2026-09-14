/**
 * Tests for the side drawer's width profile.
 *
 * The selection is a pure function of the active view, so it is asserted
 * without mounting the layout, which reaches for every store the chat route
 * owns.
 */

import { describe, expect, test } from "bun:test";

import { DETAIL_SHELL_BODY_INSET_PX } from "@/components/detail-shell";
import {
  CHAT_INFO_BODY_WIDTH_PX,
  CHAT_INFO_DRAWER_WIDTH_PX,
} from "@/domains/chat/components/chat-info-drawer-width";
import type { MainView } from "@/stores/viewer-store";

import { rightDrawerWidthProfile } from "./chat-content-layout";

describe("rightDrawerWidthProfile", () => {
  test("Chat Info opens at the mock's width under its own key", () => {
    expect(rightDrawerWidthProfile("chat-info")).toEqual({
      storageKey: "chatInfoPanelWidth",
      defaultWidth: CHAT_INFO_DRAWER_WIDTH_PX,
    });
  });

  test("the drawer width is the mock's body plus the shell's two insets", () => {
    expect(CHAT_INFO_DRAWER_WIDTH_PX).toBe(
      CHAT_INFO_BODY_WIDTH_PX + 2 * DETAIL_SHELL_BODY_INSET_PX,
    );
  });

  test.each<MainView>([
    "chat",
    "document",
    "tool-detail",
    "activity-steps",
    "subagent-detail",
    "skill-detail",
    "channel-setup",
  ])("%s keeps the shared key and the drawer's own default", (mainView) => {
    // No `defaultWidth`, so `AnimatedRightDrawer` applies its own.
    expect(rightDrawerWidthProfile(mainView)).toEqual({
      storageKey: "rightPanelWidth",
    });
  });

  test("the two profiles never share a key", () => {
    expect(rightDrawerWidthProfile("chat-info").storageKey).not.toBe(
      rightDrawerWidthProfile("chat").storageKey,
    );
  });
});
