/**
 * The settings card is the user-initiated half of the feature: it ignores the
 * prompt's decline memory, and it is the only way back to the default icon.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { createElement } from "react";

import type { AppIconState } from "@/runtime/app-icon";
import type { AvatarState } from "@/types/avatar";

const TRAITS = {
  bodyShape: "blob",
  eyeStyle: "curious",
  color: "cosmic-purple",
};
const ICON = "avatar-blob-curious-cosmic-purple";

const CHARACTER: AvatarState = {
  kind: "character",
  traits: TRAITS,
  source: "builder",
  image: null,
};

const IMAGE: AvatarState = {
  kind: "image",
  traits: null,
  source: "upload",
  image: null,
};

let avatarState: AvatarState | null = CHARACTER;
let nativeIOS = true;
let iconState: AppIconState = {
  supported: true,
  current: null,
  available: [ICON],
};

const getAppIconState = mock(async () => iconState);
const setAppIcon = mock(async (_name: string | null) => true);

mock.module("@/runtime/app-icon", () => ({ getAppIconState, setAppIcon }));
mock.module("@/runtime/platform-detection", () => ({
  useIsNativeIOS: () => nativeIOS,
}));
mock.module("@/hooks/use-assistant-avatar", () => ({
  useAssistantAvatar: () => ({
    components: null,
    traits: avatarState?.traits ?? null,
    customImageUrl: null,
    state: avatarState,
    isLoading: false,
    invalidate: () => {},
  }),
}));

const { AppIconCard } =
  await import("@/domains/settings/components/app-icon-card");
const { useClientFeatureFlagStore } =
  await import("@/stores/client-feature-flag-store");
const { useResolvedAssistantsStore } =
  await import("@/stores/resolved-assistants-store");

function buttonByText(text: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>("button")).find(
    (element) => element.textContent?.trim() === text,
  );
}

async function renderCard() {
  const view = render(createElement(AppIconCard));
  await act(async () => {
    await Promise.resolve();
  });
  return view;
}

beforeEach(() => {
  avatarState = CHARACTER;
  nativeIOS = true;
  iconState = { supported: true, current: null, available: [ICON] };
  localStorage.clear();
  useClientFeatureFlagStore.setState({ iosAvatarAppIcon: true });
  useResolvedAssistantsStore.setState({ activeAssistantId: "asst-1" });
});

afterEach(() => {
  cleanup();
  getAppIconState.mockClear();
  setAppIcon.mockClear();
  useClientFeatureFlagStore.setState({ iosAvatarAppIcon: false });
  useResolvedAssistantsStore.setState({ activeAssistantId: null });
});

describe("AppIconCard", () => {
  test("draws nothing with the flag off", async () => {
    useClientFeatureFlagStore.setState({ iosAvatarAppIcon: false });

    const { container } = await renderCard();

    expect(container.innerHTML).toBe("");
    expect(getAppIconState).not.toHaveBeenCalled();
  });

  test("draws nothing on a build with no alternate icons", async () => {
    iconState = { supported: false, current: null, available: [] };

    const { container } = await renderCard();

    await waitFor(() => {
      expect(getAppIconState).toHaveBeenCalled();
    });
    expect(container.innerHTML).toBe("");
  });

  test("matches a name the user already declined in the prompt", async () => {
    localStorage.setItem(`vellum:appIcon:declined:${ICON}`, "1");

    await renderCard();

    await waitFor(() => {
      expect(buttonByText("Match avatar")).toBeDefined();
    });
    act(() => {
      buttonByText("Match avatar")?.click();
    });

    await waitFor(() => {
      expect(setAppIcon).toHaveBeenCalledTimes(1);
    });
    expect(setAppIcon.mock.calls[0]?.[0]).toBe(ICON);
  });

  test("offers no reset while the avatar is a character", async () => {
    iconState = { supported: true, current: ICON, available: [ICON] };

    await renderCard();

    await waitFor(() => {
      expect(getAppIconState).toHaveBeenCalled();
    });
    expect(buttonByText("Use default")).toBeUndefined();
    expect(buttonByText("Match avatar")).toBeUndefined();
  });

  test("offers a reset once the avatar is no longer a character", async () => {
    avatarState = IMAGE;
    iconState = { supported: true, current: ICON, available: [ICON] };

    await renderCard();

    await waitFor(() => {
      expect(buttonByText("Use default")).toBeDefined();
    });
    act(() => {
      buttonByText("Use default")?.click();
    });

    await waitFor(() => {
      expect(setAppIcon).toHaveBeenCalledTimes(1);
    });
    expect(setAppIcon.mock.calls[0]?.[0]).toBeNull();
  });

  test("offers no reset while the default icon is showing", async () => {
    avatarState = IMAGE;

    await renderCard();

    await waitFor(() => {
      expect(getAppIconState).toHaveBeenCalled();
    });
    expect(buttonByText("Use default")).toBeUndefined();
  });
});
