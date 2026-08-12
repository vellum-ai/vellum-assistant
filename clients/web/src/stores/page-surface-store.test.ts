import { afterEach, describe, expect, it } from "bun:test";

import {
  DEFAULT_SHELL_BACKGROUND,
  resolveShellBackground,
  usePageSurfaceStore,
} from "@/stores/page-surface-store";

afterEach(() => {
  usePageSurfaceStore.getState().setSurface(null);
});

describe("resolveShellBackground", () => {
  it("paints a published surface on the native mobile shells", () => {
    expect(resolveShellBackground("var(--surface-overlay)", true)).toBe(
      "var(--surface-overlay)",
    );
  });

  it("keeps the neutral canvas off native mobile, whatever a page publishes", () => {
    expect(resolveShellBackground("var(--surface-overlay)", false)).toBe(
      DEFAULT_SHELL_BACKGROUND,
    );
  });

  it("falls back to the neutral canvas when no page publishes one", () => {
    expect(resolveShellBackground(null, true)).toBe(DEFAULT_SHELL_BACKGROUND);
    expect(resolveShellBackground(null, false)).toBe(DEFAULT_SHELL_BACKGROUND);
  });
});

describe("usePageSurfaceStore", () => {
  it("publishes and clears a surface", () => {
    usePageSurfaceStore.getState().setSurface("var(--surface-overlay)");
    expect(usePageSurfaceStore.getState().surface).toBe(
      "var(--surface-overlay)",
    );

    usePageSurfaceStore.getState().setSurface(null);
    expect(usePageSurfaceStore.getState().surface).toBeNull();
  });

  it("no-ops when the surface is unchanged", () => {
    usePageSurfaceStore.getState().setSurface("var(--surface-overlay)");
    const before = usePageSurfaceStore.getState();

    usePageSurfaceStore.getState().setSurface("var(--surface-overlay)");

    expect(usePageSurfaceStore.getState()).toBe(before);
  });
});
