/**
 * The settings card is the user-initiated half of the feature: it ignores the
 * prompt's decline memory, and it is the only way back to the default icon, so
 * Reset stays reachable for as long as one of our icons is applied.
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
/** One of ours, applied for an avatar the assistant no longer wears. */
const STALE_ICON = "avatar-blob-curious-moss";

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
// Mirrors the shell: a successful swap changes what the next read reports.
const setAppIcon = mock(async (name: string | null) => {
  iconState = { ...iconState, current: name };
  return true;
});

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
const { APP_ICON_UNSUPPORTED, useAppIconStore } =
  await import("@/stores/app-icon-store");
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
  useAppIconStore.setState({ snapshot: APP_ICON_UNSUPPORTED });
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

  test("keeps a reset once the icon matches the avatar", async () => {
    iconState = { supported: true, current: ICON, available: [ICON] };

    await renderCard();

    await waitFor(() => {
      expect(buttonByText("Use default")).toBeDefined();
    });
    // Nothing left to match, so Reset stands alone.
    expect(buttonByText("Match avatar")).toBeUndefined();
  });

  test("keeps a reset available after a successful match", async () => {
    await renderCard();
    await waitFor(() => {
      expect(buttonByText("Match avatar")).toBeDefined();
    });

    act(() => {
      buttonByText("Match avatar")?.click();
    });

    await waitFor(() => {
      expect(buttonByText("Use default")).toBeDefined();
    });
    expect(buttonByText("Match avatar")).toBeUndefined();

    setAppIcon.mockClear();
    act(() => {
      buttonByText("Use default")?.click();
    });

    await waitFor(() => {
      expect(setAppIcon).toHaveBeenCalledTimes(1);
    });
    expect(setAppIcon.mock.calls[0]?.[0]).toBeNull();
  });

  test("offers reset beside match while a stale icon of ours is applied", async () => {
    iconState = {
      supported: true,
      current: STALE_ICON,
      available: [ICON, STALE_ICON],
    };

    await renderCard();

    await waitFor(() => {
      expect(buttonByText("Match avatar")).toBeDefined();
    });
    expect(buttonByText("Use default")).toBeDefined();
  });

  test("offers no reset for an icon this feature never applied", async () => {
    avatarState = IMAGE;
    iconState = {
      supported: true,
      current: "seasonal-winter",
      available: [ICON, "seasonal-winter"],
    };

    await renderCard();

    await waitFor(() => {
      expect(getAppIconState).toHaveBeenCalled();
    });
    expect(buttonByText("Use default")).toBeUndefined();
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
