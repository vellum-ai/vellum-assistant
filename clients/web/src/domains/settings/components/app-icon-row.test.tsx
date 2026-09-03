/**
 * The row is the whole surface: it exists only where the feature is switched
 * on, it shows the icon the home screen actually holds, and the picker it
 * opens is the only thing in the app that reaches the shell. These tests drive
 * it through the real hook against a stand-in shell, so what they pin is the
 * round trip, from a press to a re-read of the home screen.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";

import { APP_ICON_GROUNDS } from "@/components/ios-widget-previews/vellum-app-icon-mark";
import { appIconNameForTraits } from "@/utils/avatar-app-icon";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import { tightPathBBox, unionBBox } from "@/utils/eye-bbox";
import type { AppIconState } from "@/runtime/app-icon";
import type { AvatarState } from "@/types/avatar";

const TRAITS = { bodyShape: "blob", eyeStyle: "goofy", color: "teal" };
const AVATAR_ICON = "avatar-eyes-goofy-teal";

/** Where the Icon Composer bundles the shells ship live. */
const ICON_BUNDLE_DIR = join(import.meta.dir, "../../../../../ios/App/App");

/** One entry of a bundle's root `fill-specializations` array. */
interface FillSpecialization {
  appearance?: string;
  value?: { solid?: string };
}

/**
 * The `color(display-p3 ...)` a bundle's own ground reads as, taken off the
 * bundle rather than named here, so a fill edited in Icon Composer fails this
 * file instead of leaving the thumbnail depicting a color no shell installs.
 * The entry carrying no `appearance` is the default one; every appearance in
 * these bundles pins the same fill.
 */
function bundleGroundP3(bundle: string): string {
  const path = join(ICON_BUNDLE_DIR, bundle, "icon.json");
  const specializations: FillSpecialization[] =
    JSON.parse(readFileSync(path, "utf8"))["fill-specializations"] ?? [];
  const solid = specializations.find(
    (entry) => entry.appearance === undefined,
  )?.value?.solid;
  if (typeof solid !== "string") {
    throw new Error(`${bundle} declares no default solid fill`);
  }
  const coordinates = solid.startsWith("display-p3:")
    ? solid.slice("display-p3:".length).split(",")
    : [];
  if (coordinates.length !== 4) {
    throw new Error(`${bundle} fill is not display-p3 R,G,B,A: ${solid}`);
  }
  const channels = coordinates.slice(0, 3).map((coordinate) => {
    const channel = Number(coordinate);
    if (!Number.isFinite(channel)) {
      throw new Error(`${bundle} fill has a non-numeric channel: ${solid}`);
    }
    return channel;
  });
  return `color(display-p3 ${channels.join(" ")})`;
}

const DEV_GROUND_P3 = bundleGroundP3("AppIcon-Dev.icon");
const STAGING_GROUND_P3 = bundleGroundP3("AppIcon-Staging.icon");

/** Where the Android flavors keep their own resources. */
const ANDROID_FLAVOR_DIR = join(
  import.meta.dir,
  "../../../../../android/app/src",
);

/**
 * The `launcher_background` a flavor declares, read off the flavor rather than
 * named here for the same reason the bundles above are read: an edited resource
 * fails this file instead of leaving the thumbnail depicting a field no shell
 * installs.
 */
function flavorLauncherBackground(flavor: string): string {
  const path = join(ANDROID_FLAVOR_DIR, flavor, "res/values/colors.xml");
  const fill = readFileSync(path, "utf8").match(
    /name="launcher_background"\s*>\s*(#[0-9A-Fa-f]{6})\s*</,
  )?.[1];
  if (!fill) {
    throw new Error(`${flavor} declares no launcher_background`);
  }
  return fill;
}

const CHARACTER: AvatarState = {
  kind: "character",
  traits: TRAITS,
  source: "builder",
  image: null,
  accent: null,
};

const IMAGE: AvatarState = {
  kind: "image",
  traits: null,
  source: "upload",
  image: null,
  accent: null,
};

let avatarState: AvatarState | null = CHARACTER;
let nativeIOS = true;
let nativeAndroid = false;
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

/**
 * Application id the stand-in shell reports, or null for a shell whose bridge
 * cannot answer at all. It is what the row reads its primary icon's ground
 * from, since the icon belongs to the installed build rather than to the web
 * deploy loaded into it.
 */
let shellAppId: string | null = "ai.vocify-inc.vellum-assistant-ios";
const getInfoMock = mock(async () => {
  if (shellAppId === null) {
    throw new Error("App.getInfo unavailable");
  }
  return { id: shellAppId, name: "Vellum", version: "1.0.0", build: "1" };
});

import * as platformDetection from "@/runtime/platform-detection";

mock.module("@capacitor/app", () => ({ App: { getInfo: getInfoMock } }));
mock.module("@/runtime/app-icon", () => ({ getAppIconState, setAppIcon }));
mock.module("@/runtime/platform-detection", () => ({
  ...platformDetection,
  useIsNativeIOS: () => nativeIOS,
  useIsNativeAndroid: () => nativeAndroid,
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

// Warm the module cache so the row's lazy `import("@capacitor/app")` resolves
// against the mock without a loader turn of its own.
await import("@capacitor/app");

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

/**
 * Build environment the row falls back to when the shell names none. Readonly
 * at the type level only; the underlying object is writable at runtime.
 */
const buildEnv = import.meta.env as Record<string, string | undefined>;
let previousBuildEnv: string | undefined;

/**
 * happy-dom answers every `CSS.supports` with true and hands back a fresh `CSS`
 * on each read of the global, so a renderer with no `color(display-p3 ...)` is
 * stood in for by swapping the whole global out.
 */
const cssDescriptor = Object.getOwnPropertyDescriptor(globalThis, "CSS");

function dropDisplayP3Support() {
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    value: { supports: () => false },
  });
}

function restoreDisplayP3Support() {
  if (cssDescriptor) {
    Object.defineProperty(globalThis, "CSS", cssDescriptor);
  }
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

/**
 * Put the stand-in shell on Android, flag and all. Android carries its own
 * flag, so naming the platform without opening its gate draws nothing.
 */
function runOnAndroidShell(appId: string) {
  nativeIOS = false;
  nativeAndroid = true;
  shellAppId = appId;
  useClientFeatureFlagStore.setState({ androidAvatarAppIcon: true });
}

beforeEach(() => {
  // The default thumbnail follows the shell it runs in, so every test that is
  // not about that runs in the one users install.
  previousBuildEnv = buildEnv.VITE_SENTRY_ENVIRONMENT;
  buildEnv.VITE_SENTRY_ENVIRONMENT = "production";
  shellAppId = "ai.vocify-inc.vellum-assistant-ios";
  avatarState = CHARACTER;
  nativeIOS = true;
  nativeAndroid = false;
  swapSucceeds = true;
  iconState = { supported: true, current: null, available: ALL_ICONS };
  useAppIconStore.setState({ snapshot: APP_ICON_UNSUPPORTED });
  useClientFeatureFlagStore.setState({ androidAvatarAppIcon: false });
  useResolvedAssistantsStore.setState({ activeAssistantId: "asst-1" });
});

afterEach(() => {
  buildEnv.VITE_SENTRY_ENVIRONMENT = previousBuildEnv;
  restoreDisplayP3Support();
  cleanup();
  getAppIconState.mockClear();
  setAppIcon.mockClear();
  getInfoMock.mockClear();
  useClientFeatureFlagStore.setState({ androidAvatarAppIcon: false });
  useResolvedAssistantsStore.setState({ activeAssistantId: null });
});

describe("AppIconRow", () => {
  test("draws nothing on Android without its own flag", async () => {
    nativeIOS = false;
    nativeAndroid = true;

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

  // Every shell ships its own primary icon and they do not share a field, so
  // the thumbnail standing in for one reads the application id of the shell it
  // is running in. The web deploy loaded into that shell answers a different
  // question and gets this backwards whenever the two disagree.
  describe("the default thumbnail follows the shell", () => {
    test("draws the Dev shell's pink field", async () => {
      shellAppId = "ai.vocify-inc.vellum-assistant-ios.dev";

      await renderRow();

      await waitFor(() => {
        expect(previewFill()).toBe(DEV_GROUND_P3);
      });
      expect(previewEyePaths()).toEqual(catalogPaths("quirky"));
    });

    test("draws the Staging shell's yellow field", async () => {
      shellAppId = "ai.vocify-inc.vellum-assistant-ios.staging";

      await renderRow();

      await waitFor(() => {
        expect(previewFill()).toBe(STAGING_GROUND_P3);
      });
      expect(previewEyePaths()).toEqual(catalogPaths("quirky"));
    });

    test("reads an Android shell's flavor suffix too", async () => {
      shellAppId = "ai.vellum.assistant.dev";

      await renderRow();

      await waitFor(() => {
        expect(previewFill()).toBe(DEV_GROUND_P3);
      });
    });

    test("keeps a production shell green on a dev web deploy", async () => {
      buildEnv.VITE_SENTRY_ENVIRONMENT = "dev";

      await renderRow();

      await waitFor(() => {
        expect(getInfoMock).toHaveBeenCalled();
      });
      expect(previewFill()).toBe(hexFor("green"));
    });

    test("falls back to the build environment for an unknown shell", async () => {
      buildEnv.VITE_SENTRY_ENVIRONMENT = "staging";
      shellAppId = "com.example.some-other-shell";

      await renderRow();

      await waitFor(() => {
        expect(previewFill()).toBe(STAGING_GROUND_P3);
      });
    });

    test("draws the Dev field for a local build, which runs App Dev", async () => {
      delete buildEnv.VITE_SENTRY_ENVIRONMENT;
      shellAppId = null;

      await renderRow();

      await waitFor(() => {
        expect(previewFill()).toBe(DEV_GROUND_P3);
      });
    });

    // The bundle fill and the hex name one color in two gamuts, so the sRGB
    // reading is what a renderer that cannot parse `color()` falls back to.
    test("paints the sRGB ground where color() will not parse", async () => {
      dropDisplayP3Support();
      shellAppId = "ai.vocify-inc.vellum-assistant-ios.dev";

      await renderRow();

      await waitFor(() => {
        expect(previewFill()).toBe(APP_ICON_GROUNDS.dev);
      });
    });

    test("paints the sRGB ground off a build environment too", async () => {
      dropDisplayP3Support();
      buildEnv.VITE_SENTRY_ENVIRONMENT = "staging";
      shellAppId = "com.example.some-other-shell";

      await renderRow();

      await waitFor(() => {
        expect(previewFill()).toBe(APP_ICON_GROUNDS.staging);
      });
    });

    test("leaves an applied alternate in its own color off production", async () => {
      shellAppId = "ai.vocify-inc.vellum-assistant-ios.dev";
      iconState = {
        supported: true,
        current: AVATAR_ICON,
        available: ALL_ICONS,
      };

      await renderRow();

      await waitFor(() => {
        expect(buttonByText("Change")).toBeDefined();
      });
      expect(previewFill()).toBe(hexFor("teal"));
    });
  });

  // Android draws its launcher field from per-flavor resources that name the
  // same colors as the iOS bundles in plain sRGB, so the thumbnail standing in
  // for the primary icon reads the shell's platform as well as its build.
  describe("the default thumbnail follows the Android flavor", () => {
    test("draws the dev flavor's pink field", async () => {
      runOnAndroidShell("ai.vellum.assistant.dev");

      await renderRow();

      await waitFor(() => {
        expect(previewFill()).toBe(flavorLauncherBackground("dev"));
      });
      // Naming one ground for both platforms holds only while the flavor
      // resource and the shared constant agree, so this comparison fails
      // whenever either side moves alone.
      expect(flavorLauncherBackground("dev")).toBe(APP_ICON_GROUNDS.dev);
      expect(previewEyePaths()).toEqual(catalogPaths("quirky"));
    });

    test("draws the staging flavor's yellow field", async () => {
      runOnAndroidShell("ai.vellum.assistant.staging");

      await renderRow();

      await waitFor(() => {
        expect(previewFill()).toBe(flavorLauncherBackground("staging"));
      });
      expect(flavorLauncherBackground("staging")).toBe(
        APP_ICON_GROUNDS.staging,
      );
      expect(previewEyePaths()).toEqual(catalogPaths("quirky"));
    });

    test("leaves the production flavor on the catalog green", async () => {
      runOnAndroidShell("ai.vellum.assistant");

      await renderRow();

      await waitFor(() => {
        expect(buttonByText("Change")).toBeDefined();
      });
      // Production is the one flavor the row names no field for, which is only
      // honest while the flavor itself declares the catalog's own green.
      expect(flavorLauncherBackground("production")).toBe(hexFor("green"));
      expect(hexFor("green")).toBe(APP_ICON_GROUNDS.production);
      expect(previewFill()).toBe(hexFor("green"));
    });
  });

  // A press means something different on each shell: iOS swaps the icon behind
  // its own alert, Android waits for the app to leave the foreground and can
  // drop a pinned shortcut on the way.
  describe("the picker's copy follows the shell", () => {
    test("names the deferred apply and the pinned shortcut on Android", async () => {
      runOnAndroidShell("ai.vellum.assistant");
      await renderRow();
      await waitFor(() => {
        expect(buttonByText("Change")).toBeDefined();
      });

      await press("Change");

      expect(modal()?.textContent).toContain(
        "Android applies your choice once you leave the app",
      );
      expect(modal()?.textContent).not.toContain("iOS");
    });

    test("names Android as the shell that kept the old icon", async () => {
      swapSucceeds = false;
      runOnAndroidShell("ai.vellum.assistant");
      await renderRow();
      await waitFor(() => {
        expect(buttonByText("Change")).toBeDefined();
      });

      await press("Change");
      await press("Set app icon");

      await waitFor(() => {
        expect(
          document.querySelector('[role="alert"]')?.textContent?.trim(),
        ).toBe(
          "Android did not change your home screen icon. You can try again.",
        );
      });
      expect(modal()).not.toBeNull();
    });
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
