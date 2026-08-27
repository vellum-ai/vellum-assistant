/**
 * The row is the whole surface: it exists only where the feature is switched
 * on, it shows the icon the home screen actually holds, and the picker it
 * opens is the only thing in the app that reaches the shell. These tests drive
 * it through the real hook against a stand-in shell, so what they pin is the
 * round trip, from a press to a re-read of the home screen.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";

import { appIconNameForTraits } from "@/utils/avatar-app-icon";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import { tightPathBBox, unionBBox } from "@/utils/eye-bbox";
import type { AppIconState } from "@/runtime/app-icon";
import type { AvatarState } from "@/types/avatar";

const TRAITS = { bodyShape: "blob", eyeStyle: "goofy", color: "teal" };
const AVATAR_ICON = "avatar-eyes-goofy-teal";

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
  available: [],
};

/** What the shell answers the next swap with: iOS is free to refuse one. */
let swapSucceeds = true;

const getAppIconState = mock(async () => iconState);
// Mirrors the shell: a successful swap changes what the next read reports, and
// a refused one leaves the home screen exactly as it was.
const setAppIcon = mock(async (name: string | null) => {
  if (!swapSucceeds) {
    return false;
  }
  iconState = { ...iconState, current: name };
  return true;
});

import * as platformDetection from "@/runtime/platform-detection";

mock.module("@/runtime/app-icon", () => ({ getAppIconState, setAppIcon }));
mock.module("@/runtime/platform-detection", () => ({
  ...platformDetection,
  useIsNativeIOS: () => nativeIOS,
}));
mock.module("@/hooks/use-assistant-avatar", () => ({
  useAssistantAvatar: () => ({
    components: BUNDLED_COMPONENTS,
    traits: avatarState?.traits ?? null,
    customImageUrl: null,
    state: avatarState,
    isLoading: false,
    invalidate: () => {},
  }),
}));

const { AppIconRow } =
  await import("@/domains/settings/components/app-icon-row");
const { APP_ICON_UNSUPPORTED, useAppIconStore } =
  await import("@/stores/app-icon-store");
const { useClientFeatureFlagStore } =
  await import("@/stores/client-feature-flag-store");
const { useResolvedAssistantsStore } =
  await import("@/stores/resolved-assistants-store");

/** Every icon the generator emits from the catalog, as a full shell would. */
const ALL_ICONS = BUNDLED_COMPONENTS.eyeStyles.flatMap((eyeStyle) =>
  BUNDLED_COMPONENTS.colors.map((color) =>
    appIconNameForTraits(eyeStyle.id, color.id),
  ),
);

function hexFor(colorId: string): string {
  const color = BUNDLED_COMPONENTS.colors.find((entry) => entry.id === colorId);
  if (!color) {
    throw new Error(`No catalog color "${colorId}"`);
  }
  return color.hex;
}

/** The style one step on from `id`, read off the catalog the rows cycle. */
function eyeStyleAfter(id: string, step: number): string {
  const styles = BUNDLED_COMPONENTS.eyeStyles;
  const index = styles.findIndex((eyeStyle) => eyeStyle.id === id);
  return styles[(index + step + styles.length) % styles.length]!.id;
}

function buttonByText(name: string): HTMLButtonElement | undefined {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find(
    (element) =>
      element.textContent?.trim() === name ||
      element.getAttribute("aria-label") === name,
  );
}

async function press(name: string) {
  const button = buttonByText(name);
  if (!button) {
    throw new Error(`No button reading "${name}"`);
  }
  await act(async () => {
    fireEvent.click(button);
  });
}

function modal(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="app-icon-modal"]');
}

/** The color the one preview on screen is painted in. */
function previewFill(): string | null {
  const fields = document.querySelectorAll<SVGRectElement>(
    '[data-testid="app-icon-preview-field"]',
  );
  return fields[0]?.getAttribute("fill") ?? null;
}

function previewEyePaths(): (string | null)[] {
  const group = document.querySelector('[data-testid="app-icon-preview-eyes"]');
  return Array.from(group?.querySelectorAll("path") ?? []).map((path) =>
    path.getAttribute("d"),
  );
}

/** Rendered width of the one preview on screen, in px. */
function previewSize(): number {
  const svg = document.querySelector('[data-testid="app-icon-preview"]');
  const width = Number(svg?.getAttribute("width"));
  if (!Number.isFinite(width) || width <= 0) {
    throw new Error("No preview rendered");
  }
  return width;
}

/** On-screen width of that preview's eye art, in px. */
function previewEyeWidth(): number {
  const group = document.querySelector('[data-testid="app-icon-preview-eyes"]');
  const transform = group?.getAttribute("transform") ?? "";
  const scale = Number(transform.match(/^matrix\((-?[\d.]+),/)?.[1]);
  if (!Number.isFinite(scale)) {
    throw new Error(`Unexpected eye transform: ${transform}`);
  }
  const paths = Array.from(group?.querySelectorAll("path") ?? []);
  const bounds = unionBBox(
    paths.map((path) => tightPathBBox(path.getAttribute("d") ?? "")),
  );
  return bounds.w * scale;
}

function catalogPaths(eyeStyleId: string): (string | null)[] {
  const eyeStyle = BUNDLED_COMPONENTS.eyeStyles.find(
    (entry) => entry.id === eyeStyleId,
  );
  return eyeStyle?.paths.map((path) => path.svgPath) ?? [];
}

async function renderRow() {
  const view = render(createElement(AppIconRow));
  await act(async () => {
    await Promise.resolve();
  });
  return view;
}

beforeEach(() => {
  avatarState = CHARACTER;
  nativeIOS = true;
  swapSucceeds = true;
  iconState = { supported: true, current: null, available: ALL_ICONS };
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

describe("AppIconRow", () => {
  test("draws nothing with the flag off", async () => {
    useClientFeatureFlagStore.setState({ iosAvatarAppIcon: false });

    const { container } = await renderRow();

    expect(container.innerHTML).toBe("");
    expect(getAppIconState).not.toHaveBeenCalled();
  });

  test("draws nothing off native iOS", async () => {
    nativeIOS = false;

    const { container } = await renderRow();

    expect(container.innerHTML).toBe("");
    expect(getAppIconState).not.toHaveBeenCalled();
  });

  test("draws nothing on a build that ships no alternate icons", async () => {
    iconState = { supported: false, current: null, available: [] };

    const { container } = await renderRow();

    await waitFor(() => {
      expect(getAppIconState).toHaveBeenCalled();
    });
    expect(container.innerHTML).toBe("");
  });

  test("previews the default icon while no alternate is applied", async () => {
    await renderRow();

    await waitFor(() => {
      expect(buttonByText("Change")).toBeDefined();
    });
    expect(previewFill()).toBe(hexFor("green"));
    expect(previewEyePaths()).toEqual(catalogPaths("quirky"));
  });

  test("previews the icon the home screen holds", async () => {
    iconState = { supported: true, current: AVATAR_ICON, available: ALL_ICONS };

    await renderRow();

    await waitFor(() => {
      expect(buttonByText("Change")).toBeDefined();
    });
    expect(previewFill()).toBe(hexFor("teal"));
    expect(previewEyePaths()).toEqual(catalogPaths("goofy"));
  });

  test("frames the default icon the way the primary asset frames it", async () => {
    await renderRow();

    await waitFor(() => {
      expect(buttonByText("Change")).toBeDefined();
    });
    // The icon the app ships spans half its field whatever pair it draws.
    expect(previewEyeWidth()).toBeCloseTo(previewSize() / 2, 1);
  });

  test("frames an applied alternate the way its own bundle frames it", async () => {
    iconState = {
      supported: true,
      current: appIconNameForTraits("bashful", "green"),
      available: ALL_ICONS,
    };

    await renderRow();

    await waitFor(() => {
      expect(buttonByText("Change")).toBeDefined();
    });
    expect(previewEyePaths()).toEqual(catalogPaths("bashful"));
    // bashful is one of the pairs the span table frames narrower than the
    // default. Its exact share is pinned in the preview's own tests.
    expect(previewEyeWidth()).toBeLessThan(previewSize() / 2 - 1);
  });

  test("applies the pair the picker was left on and closes", async () => {
    await renderRow();
    await waitFor(() => {
      expect(buttonByText("Change")).toBeDefined();
    });

    await press("Change");
    expect(modal()).not.toBeNull();

    await press("Next eyes");
    await press("Set app icon");

    await waitFor(() => {
      expect(setAppIcon).toHaveBeenCalledTimes(1);
    });
    // The picker opens on the avatar's pair, so one step lands on the style
    // after it.
    expect(setAppIcon.mock.calls[0]?.[0]).toBe(
      appIconNameForTraits(eyeStyleAfter("goofy", 1), "teal"),
    );
    await waitFor(() => {
      expect(modal()).toBeNull();
    });
    expect(previewFill()).toBe(hexFor("teal"));
    expect(previewEyePaths()).toEqual(catalogPaths(eyeStyleAfter("goofy", 1)));
  });

  test("keeps the picker up when iOS leaves the home screen alone", async () => {
    swapSucceeds = false;
    await renderRow();
    await waitFor(() => {
      expect(buttonByText("Change")).toBeDefined();
    });

    await press("Change");
    await press("Set app icon");

    await waitFor(() => {
      expect(
        document.querySelector('[role="alert"]')?.textContent?.trim(),
      ).toBe("iOS did not change your home screen icon. You can try again.");
    });
    expect(modal()).not.toBeNull();
  });

  test("puts the default icon back", async () => {
    iconState = { supported: true, current: AVATAR_ICON, available: ALL_ICONS };
    await renderRow();
    await waitFor(() => {
      expect(buttonByText("Change")).toBeDefined();
    });

    await press("Change");
    await press("Reset to default");

    await waitFor(() => {
      expect(setAppIcon).toHaveBeenCalledTimes(1);
    });
    expect(setAppIcon.mock.calls[0]?.[0]).toBeNull();
    await waitFor(() => {
      expect(modal()).toBeNull();
    });
    expect(previewFill()).toBe(hexFor("green"));
  });

  test("hands a character avatar the one-tap shortcut", async () => {
    await renderRow();
    await waitFor(() => {
      expect(buttonByText("Change")).toBeDefined();
    });

    await press("Change");
    // The picker opens on the avatar's pair, so cycling away first is what
    // gives the shortcut something to undo.
    await press("Next eyes");
    await press("Match avatar");
    await press("Set app icon");

    await waitFor(() => {
      expect(setAppIcon).toHaveBeenCalledTimes(1);
    });
    expect(setAppIcon.mock.calls[0]?.[0]).toBe(AVATAR_ICON);
  });

  test("offers the avatar shortcut only to a character avatar", async () => {
    avatarState = IMAGE;
    await renderRow();
    await waitFor(() => {
      expect(buttonByText("Change")).toBeDefined();
    });

    await press("Change");

    expect(modal()).not.toBeNull();
    expect(buttonByText("Match avatar")).toBeUndefined();
    // The picker still applies: an uploaded image rules out the shortcut, not
    // the choice.
    await press("Set app icon");
    await waitFor(() => {
      expect(setAppIcon).toHaveBeenCalledTimes(1);
    });
    expect(setAppIcon.mock.calls[0]?.[0]).toBe(
      appIconNameForTraits("quirky", "green"),
    );
  });
});
