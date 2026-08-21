/**
 * The prompt is the only surface that asks, so the tests here are about when
 * it must stay quiet: a non-character avatar, a build without the bundle, the
 * flag off, onboarding on screen, a name already declined, and a name already
 * asked about this session. An offer already on screen has to go quiet on the
 * same terms, so the tests below also take the question away mid-display.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter } from "react-router";

import type { AppIconState } from "@/runtime/app-icon";
import type { AvatarState, CharacterComponents } from "@/types/avatar";

const COMPONENTS: CharacterComponents = {
  bodyShapes: [
    {
      id: "blob",
      viewBox: { width: 128, height: 256 },
      faceCenter: { x: 64, y: 80 },
      svgPath: "M 64 128 C 80 144 96 160 64 176 C 32 160 48 144 64 128 Z",
    },
  ],
  eyeStyles: [
    {
      id: "curious",
      sourceViewBox: { width: 32, height: 32 },
      eyeCenter: { x: 16, y: 16 },
      paths: [{ svgPath: "M 8 16 A 8 8 0 0 1 24 16", color: "#000" }],
    },
  ],
  colors: [{ id: "cosmic-purple", hex: "#7c3aed" }],
  faceCenterOverrides: [],
};

const TRAITS = {
  bodyShape: "blob",
  eyeStyle: "curious",
  color: "cosmic-purple",
};
const ICON = "avatar-blob-curious-cosmic-purple";
const OTHER_TRAITS = { ...TRAITS, color: "moss" };
const OTHER_ICON = "avatar-blob-curious-moss";

const CHARACTER: AvatarState = {
  kind: "character",
  traits: TRAITS,
  source: "builder",
  image: null,
};

const OTHER_CHARACTER: AvatarState = {
  kind: "character",
  traits: OTHER_TRAITS,
  source: "builder",
  image: null,
};

/** An uploaded image whose traits sidecar was never cleaned up. */
const IMAGE_WITH_STALE_TRAITS: AvatarState = {
  kind: "image",
  traits: TRAITS,
  source: "upload",
  image: null,
};

let avatarState: AvatarState | null = CHARACTER;
let nativeIOS = true;
let iconState: AppIconState = {
  supported: true,
  current: null,
  available: [ICON, OTHER_ICON],
};

const getAppIconState = mock(async () => iconState);
const setAppIcon = mock(async (_name: string | null) => true);

mock.module("@/runtime/app-icon", () => ({ getAppIconState, setAppIcon }));
mock.module("@/runtime/platform-detection", () => ({
  useIsNativeIOS: () => nativeIOS,
}));
mock.module("@/hooks/use-assistant-avatar", () => ({
  useAssistantAvatar: () => ({
    components: COMPONENTS,
    traits: avatarState?.traits ?? null,
    customImageUrl: null,
    state: avatarState,
    isLoading: false,
    invalidate: () => {},
  }),
}));

const { AppIconMatchPrompt, __resetAppIconOfferSession } =
  await import("@/components/avatar/app-icon-match-prompt");
const { APP_ICON_UNSUPPORTED, useAppIconStore } =
  await import("@/stores/app-icon-store");
const { useClientFeatureFlagStore } =
  await import("@/stores/client-feature-flag-store");
const { useInChatOnboardingStore } =
  await import("@/stores/in-chat-onboarding-store");
const { useOnboardingFocusStore } =
  await import("@/stores/onboarding-focus-store");

function renderPrompt(pathname = "/assistant/c/conv-1") {
  return render(
    createElement(
      MemoryRouter,
      { initialEntries: [pathname] },
      createElement(AppIconMatchPrompt, { assistantId: "asst-1" }),
    ),
  );
}

function rerenderPrompt(view: ReturnType<typeof renderPrompt>) {
  view.rerender(
    createElement(
      MemoryRouter,
      { initialEntries: ["/assistant/c/conv-1"] },
      createElement(AppIconMatchPrompt, { assistantId: "asst-1" }),
    ),
  );
}

function dialogTitle(): string | null {
  const title = document.querySelector<HTMLElement>(
    '[data-slot="modal-title"]',
  );
  return title?.textContent?.trim() ?? null;
}

function clickByText(text: string) {
  const button = Array.from(
    document.querySelectorAll<HTMLElement>("button"),
  ).find((element) => element.textContent?.trim() === text);
  expect(button).toBeDefined();
  act(() => {
    button?.click();
  });
}

async function expectPrompt() {
  await waitFor(() => {
    expect(dialogTitle()).toBe("Match your app icon to your avatar?");
  });
}

async function expectNoPrompt() {
  await waitFor(() => {
    expect(getAppIconState).toHaveBeenCalled();
  });
  // Let any offer effect flush before asserting the absence.
  await act(async () => {
    await Promise.resolve();
  });
  expect(dialogTitle()).toBeNull();
}

beforeEach(() => {
  avatarState = CHARACTER;
  nativeIOS = true;
  iconState = { supported: true, current: null, available: [ICON, OTHER_ICON] };
  localStorage.clear();
  __resetAppIconOfferSession();
  useAppIconStore.setState({ snapshot: APP_ICON_UNSUPPORTED });
  useClientFeatureFlagStore.setState({ iosAvatarAppIcon: true });
  useOnboardingFocusStore.setState({ focused: false });
  useInChatOnboardingStore.setState({ prototypeActive: false, stage: "done" });
});

afterEach(() => {
  cleanup();
  getAppIconState.mockClear();
  setAppIcon.mockClear();
  useClientFeatureFlagStore.setState({ iosAvatarAppIcon: false });
});

describe("AppIconMatchPrompt", () => {
  test("offers the matching icon for a character avatar", async () => {
    renderPrompt();

    await expectPrompt();
  });

  test("applies the target on Apply and closes", async () => {
    renderPrompt();
    await expectPrompt();

    clickByText("Apply");

    await waitFor(() => {
      expect(setAppIcon).toHaveBeenCalledTimes(1);
    });
    expect(setAppIcon.mock.calls[0]?.[0]).toBe(ICON);
    await waitFor(() => {
      expect(dialogTitle()).toBeNull();
    });
    // Accepting is not declining: closing the dialog from the Apply path must
    // not write the decline the dismiss path writes.
    expect(localStorage.getItem(`vellum:appIcon:declined:${ICON}`)).toBeNull();
  });

  test("offers again when the avatar changes on another device", async () => {
    const view = renderPrompt();
    await expectPrompt();
    clickByText("Not now");
    await waitFor(() => {
      expect(dialogTitle()).toBeNull();
    });

    // The `avatar_updated` sweep refetches and the query hands back a
    // different character.
    avatarState = OTHER_CHARACTER;
    view.rerender(
      createElement(
        MemoryRouter,
        { initialEntries: ["/assistant/c/conv-1"] },
        createElement(AppIconMatchPrompt, { assistantId: "asst-1" }),
      ),
    );

    await expectPrompt();
  });

  test("never offers for an uploaded image, even with stale traits", async () => {
    avatarState = IMAGE_WITH_STALE_TRAITS;

    renderPrompt();

    await expectNoPrompt();
    expect(setAppIcon).not.toHaveBeenCalled();
  });

  test("never offers with the flag off", async () => {
    useClientFeatureFlagStore.setState({ iosAvatarAppIcon: false });

    renderPrompt();

    await act(async () => {
      await Promise.resolve();
    });
    expect(dialogTitle()).toBeNull();
    expect(getAppIconState).not.toHaveBeenCalled();
  });

  test("never offers off native iOS", async () => {
    nativeIOS = false;

    renderPrompt();

    await act(async () => {
      await Promise.resolve();
    });
    expect(dialogTitle()).toBeNull();
    expect(getAppIconState).not.toHaveBeenCalled();
  });

  test("never offers a name this build does not bundle", async () => {
    iconState = { supported: true, current: null, available: [OTHER_ICON] };

    renderPrompt();

    await expectNoPrompt();
  });

  test("never offers on an onboarding route", async () => {
    renderPrompt("/assistant/onboarding/hatching");

    await expectNoPrompt();
  });

  test("never offers while the focused onboarding chat is up", async () => {
    useOnboardingFocusStore.setState({ focused: true });

    renderPrompt();

    await expectNoPrompt();
  });

  test("never offers while the in-chat tour is running", async () => {
    useInChatOnboardingStore.setState({
      prototypeActive: true,
      stage: "tour",
    });

    renderPrompt();

    await expectNoPrompt();
  });

  test("closes an open offer when onboarding takes the screen", async () => {
    renderPrompt();
    await expectPrompt();

    act(() => {
      useOnboardingFocusStore.setState({ focused: true });
    });

    await waitFor(() => {
      expect(dialogTitle()).toBeNull();
    });
    expect(setAppIcon).not.toHaveBeenCalled();
  });

  test("closes an open offer when the target becomes one already declined", async () => {
    localStorage.setItem(`vellum:appIcon:declined:${OTHER_ICON}`, "1");
    const view = renderPrompt();
    await expectPrompt();

    // The active assistant changes. The dialog on screen asks about the icon
    // the old avatar wanted, but Apply now swaps to the new one, which this
    // user already said no to.
    avatarState = OTHER_CHARACTER;
    rerenderPrompt(view);

    await waitFor(() => {
      expect(dialogTitle()).toBeNull();
    });
    expect(setAppIcon).not.toHaveBeenCalled();
  });

  test("closes an open offer when the avatar stops mapping to an icon", async () => {
    const view = renderPrompt();
    await expectPrompt();

    avatarState = IMAGE_WITH_STALE_TRAITS;
    rerenderPrompt(view);

    await waitFor(() => {
      expect(dialogTitle()).toBeNull();
    });
    expect(setAppIcon).not.toHaveBeenCalled();
  });

  test("never offers a name declined in an earlier session", async () => {
    localStorage.setItem(`vellum:appIcon:declined:${ICON}`, "1");

    renderPrompt();

    await expectNoPrompt();
  });

  test("a decline persists but a different avatar still gets asked", async () => {
    renderPrompt();
    await expectPrompt();
    clickByText("Not now");

    expect(localStorage.getItem(`vellum:appIcon:declined:${ICON}`)).toBe("1");

    // A new session with a different avatar.
    cleanup();
    __resetAppIconOfferSession();
    avatarState = OTHER_CHARACTER;
    renderPrompt();

    await expectPrompt();
  });

  test("asks about a name at most once per session", async () => {
    renderPrompt();
    await expectPrompt();
    clickByText("Apply");
    await waitFor(() => {
      expect(dialogTitle()).toBeNull();
    });

    // Remount without clearing the session memory: applying did not decline
    // the name, and the offer must still not come back.
    cleanup();
    iconState = { supported: true, current: null, available: [ICON] };
    renderPrompt();

    await expectNoPrompt();
  });
});
