/**
 * Tests for `AssistantAvatarTile`. The avatar hook is mocked at its module
 * boundary so readiness can be flipped per test — the point of the tile is that
 * it holds its square before the creature resolves, so the dialog header it
 * sits in never reflows.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";

import * as assistantAvatarMod from "@/hooks/use-assistant-avatar";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

/** Flipped per-test to hold the avatar query in flight. */
let avatarLoading = false;
/** An uploaded avatar image, the simplest resolved avatar to assert on. */
let avatarCustomImageUrl: string | null = null;
mock.module("@/hooks/use-assistant-avatar", () => ({
  ...assistantAvatarMod,
  useAssistantAvatar: () => ({
    components: null,
    traits: null,
    customImageUrl: avatarCustomImageUrl,
    isLoading: avatarLoading,
    invalidate: () => {},
  }),
}));

const { AssistantAvatarTile } = await import("./assistant-avatar-tile");

beforeEach(() => {
  avatarLoading = false;
  avatarCustomImageUrl = null;
  useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-1" });
});

afterEach(() => {
  cleanup();
});

function renderTile() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <AssistantAvatarTile />
    </QueryClientProvider>,
  );
}

describe("AssistantAvatarTile", () => {
  test("renders the tile while the avatar query is still loading, with nothing inside it", () => {
    avatarLoading = true;

    const { getByTestId } = renderTile();

    expect(getByTestId("assistant-avatar-tile").children.length).toBe(0);
  });

  test("renders the tile with no active assistant to resolve", () => {
    useResolvedAssistantsStore.setState({ activeAssistantId: null });

    const { getByTestId } = renderTile();

    expect(getByTestId("assistant-avatar-tile").children.length).toBe(0);
  });

  test("draws the avatar once the query settles", () => {
    const { getByTestId } = renderTile();

    expect(getByTestId("assistant-avatar-tile").children.length).toBe(1);
  });

  test("draws an uploaded avatar image inside the tile", () => {
    avatarCustomImageUrl = "https://example.test/avatar.png";

    const { getByTestId, getByAltText } = renderTile();

    const image = getByAltText("Assistant avatar");
    expect(getByTestId("assistant-avatar-tile").contains(image)).toBe(true);
  });
});
