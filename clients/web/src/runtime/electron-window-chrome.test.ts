import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { TitleBarOverlayTheme } from "@vellumai/ipc-contract";

import type { ElectronHostOS } from "@/runtime/platform-detection";

/**
 * happy-dom keeps each mutation listener's report callback in a `WeakRef`
 * (`MutationObserverListener`), so a garbage collection mid-test silences the
 * observer and no further mutations are reported. Retaining the referents for
 * the life of the file makes delivery deterministic.
 */
const retainedWeakReferents = new Set<WeakKey>();
const NativeWeakRef = globalThis.WeakRef;
globalThis.WeakRef = class RetainingWeakRef<
  T extends WeakKey,
> extends NativeWeakRef<T> {
  constructor(value: T) {
    super(value);
    retainedWeakReferents.add(value);
  }
} as typeof WeakRef;

let hostOS: ElectronHostOS | null = "windows";

mock.module("@/runtime/platform-detection", () => ({
  detectElectronHostOS: () => hostOS,
}));

const { initWindowsTitleBarOverlay } = await import("./electron-window-chrome");

let published: TitleBarOverlayTheme[] = [];
let stopSync: (() => void) | null = null;

/** Start the sync and register its teardown so cases stay isolated. */
function startSync(): void {
  stopSync = initWindowsTitleBarOverlay();
}

/**
 * The token values the design library defines for each theme
 * (`packages/design-library/src/tokens.css`). Applied inline because the
 * stylesheet is not loaded in the test DOM.
 */
const THEME_TOKENS = {
  light: { surface: "#F6F5F4", content: "#24292E" },
  dark: { surface: "#17191C", content: "#F6F5F4" },
  velvet: { surface: "#121214", content: "#F6F5F4" },
} as const;

/**
 * Applies a theme the way `applyThemePreference()` does: the tokens, the
 * `data-theme` attribute, and the `dark` class both dark themes carry.
 */
function applyTheme(theme: keyof typeof THEME_TOKENS): void {
  const root = document.documentElement;
  root.style.setProperty("--surface-base", THEME_TOKENS[theme].surface);
  root.style.setProperty("--content-default", THEME_TOKENS[theme].content);
  root.setAttribute("data-theme", theme);
  root.classList.toggle("dark", theme !== "light");
  root.classList.toggle("velvet", theme === "velvet");
}

/** Let the observer's microtask-scheduled callback run. */
const flushMutations = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  hostOS = "windows";
  published = [];
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("class");
  window.vellum = {
    mainWindow: {
      ensureVisible: async () => undefined,
      setOnboarding: async () => undefined,
      setTitleBarOverlay: async (colors: TitleBarOverlayTheme) => {
        published.push(colors);
      },
    },
  } as unknown as Window["vellum"];
});

afterEach(() => {
  stopSync?.();
  stopSync = null;
  delete (window as { vellum?: unknown }).vellum;
});

describe("initWindowsTitleBarOverlay", () => {
  test("publishes the active theme's colors so the caption buttons match", async () => {
    /**
     * Tests that the native window controls are painted from the same tokens
     * the title bar itself is drawn from.
     */
    // GIVEN the renderer has resolved the dark theme
    applyTheme("dark");

    // WHEN the overlay sync starts
    startSync();
    await flushMutations();

    // THEN the dark theme's surface and text colors reach the main process,
    // along with the scheme Chromium washes the buttons from
    expect(published).toEqual([
      { color: "#17191C", symbolColor: "#F6F5F4", colorScheme: "dark" },
    ]);
  });

  test("republishes when the effective theme changes", async () => {
    /**
     * Tests that a theme switch repaints the overlay, which no stylesheet can
     * reach because the OS draws it over the webview.
     */
    // GIVEN a synced light-theme window
    applyTheme("light");
    startSync();
    await flushMutations();

    // WHEN the user switches to velvet
    applyTheme("velvet");

    // THEN velvet's own colors are published, distinct from the dark theme's,
    // and the scheme follows the theme off light
    await flushMutations();
    expect(published).toEqual([
      { color: "#F6F5F4", symbolColor: "#24292E", colorScheme: "light" },
      { color: "#121214", symbolColor: "#F6F5F4", colorScheme: "dark" },
    ]);
  });

  test("republishes when a workspace theme overrides the tokens", async () => {
    /**
     * Tests that an assistant's authored colors reach the overlay too: they
     * layer onto the base theme as inline custom properties, leaving
     * `data-theme` untouched.
     */
    // GIVEN a synced dark-theme window
    applyTheme("dark");
    startSync();
    await flushMutations();

    // WHEN a workspace theme's background and text land on the root
    const root = document.documentElement;
    root.style.setProperty("--surface-base", "#2B1B3D");
    root.style.setProperty("--content-default", "#F3E9FF");

    // THEN the authored colors are published over the base theme's
    await flushMutations();
    expect(published).toEqual([
      { color: "#17191C", symbolColor: "#F6F5F4", colorScheme: "dark" },
      { color: "#2B1B3D", symbolColor: "#F3E9FF", colorScheme: "dark" },
    ]);
  });

  test("publishes nothing when a root mutation leaves the colors alone", async () => {
    /**
     * Tests that unrelated inline custom properties (the root carries several)
     * do not walk the overlay through redundant repaints.
     */
    // GIVEN a synced dark-theme window
    applyTheme("dark");
    startSync();
    await flushMutations();

    // WHEN an unrelated custom property changes on the root
    document.documentElement.style.setProperty("--primary-base", "#e8a04c");

    // THEN the colors already painted are not republished
    await flushMutations();
    expect(published).toEqual([
      { color: "#17191C", symbolColor: "#F6F5F4", colorScheme: "dark" },
    ]);
  });

  test("stays quiet until the effective theme is resolved", async () => {
    /**
     * Tests that no colors are published before the theme is applied, so a
     * dark window never flashes light caption buttons.
     */
    // GIVEN a document with no theme applied yet
    // WHEN the overlay sync starts, then the theme lands
    startSync();
    await flushMutations();
    const beforeTheme = [...published];
    applyTheme("dark");
    await flushMutations();

    // THEN nothing is published for the unresolved document
    expect(beforeTheme).toEqual([]);
    // AND the resolved theme is published once it lands
    expect(published).toEqual([
      { color: "#17191C", symbolColor: "#F6F5F4", colorScheme: "dark" },
    ]);
  });

  test("does nothing on hosts with no themable overlay", async () => {
    /**
     * Tests that only the Windows shell publishes: macOS traffic lights are
     * system drawn and the browser has no window chrome at all.
     */
    // GIVEN the renderer runs in the macOS shell
    hostOS = "macos";
    applyTheme("dark");

    // WHEN the overlay sync starts and the theme later changes
    startSync();
    applyTheme("light");
    await flushMutations();

    // THEN the bridge is never called
    expect(published).toEqual([]);
  });

  test("tolerates a preload that predates the overlay bridge", async () => {
    /**
     * Tests the mixed-version case, where a newer renderer runs against an
     * installed shell whose preload has no overlay method.
     */
    // GIVEN a preload exposing only the older main-window methods
    window.vellum = {
      mainWindow: {
        ensureVisible: async () => undefined,
        setOnboarding: async () => undefined,
      },
    } as unknown as Window["vellum"];
    applyTheme("dark");

    // WHEN the overlay sync starts
    const start = () => {
      startSync();
    };

    // THEN it leaves the window on the system caption colors rather than
    // throwing on the missing method
    expect(start).not.toThrow();
    await flushMutations();
    expect(published).toEqual([]);
  });
});
