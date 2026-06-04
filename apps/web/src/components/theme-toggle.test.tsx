/**
 * Tests for `ThemeToggle`.
 *
 * The component is a thin wrapper over the design-library `SegmentControl`
 * (icon-only mode). We mount it via `@testing-library/react` (backed by
 * happy-dom — see `apps/web/test-setup.ts`) and assert the user-facing
 * contract: the three base segments render as labelled radios, each glyph
 * carries the mock's 14px (`h-3.5 w-3.5`) sizing, and selecting a segment
 * persists + applies the chosen preference.
 *
 * Theme state internals (`readStoredThemePreference` /
 * `writeStoredThemePreference` / `applyThemePreference`) and device-setting
 * watching are mocked — they're owned/tested elsewhere.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";

// --- Mocks ----------------------------------------------------------------

const velvetRef = { value: false };

mock.module("@/stores/client-feature-flag-store", () => {
  const store = () => null;
  store.use = {
    velvet: () => velvetRef.value,
  };
  return { useClientFeatureFlagStore: store };
});

// `watchDeviceSetting(name, cb)` returns an unsubscribe function. The toggle
// only registers it in an effect; we never fire it here.
mock.module("@/utils/device-settings", () => ({
  watchDeviceSetting: () => () => {},
}));

const writeStoredThemePreference = mock(() => {});
const applyThemePreference = mock(() => {});
const readStoredThemePreference = mock(() => "system" as const);

mock.module("@/domains/settings/utils/theme-preferences", () => ({
  readStoredThemePreference,
  writeStoredThemePreference,
  applyThemePreference,
}));

import { ThemeToggle } from "@/components/theme-toggle";

beforeEach(() => {
  velvetRef.value = false;
  writeStoredThemePreference.mockClear();
  applyThemePreference.mockClear();
  readStoredThemePreference.mockClear();
});

afterEach(() => {
  cleanup();
});

function getRadios(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="radio"]'));
}

function getRadio(label: string): HTMLElement {
  const match = getRadios().find(
    (el) => el.getAttribute("aria-label") === label,
  );
  if (!match) {
    throw new Error(
      `expected a radio with aria-label "${label}" — saw: ${getRadios()
        .map((el) => `"${el.getAttribute("aria-label")}"`)
        .join(", ")}`,
    );
  }
  return match;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe("ThemeToggle rendering", () => {
  test("renders the three base options as labelled radios", () => {
    render(<ThemeToggle />);
    const labels = getRadios().map((el) => el.getAttribute("aria-label"));
    expect(labels).toEqual(["System", "Light", "Dark"]);
  });

  test("each glyph carries the mock's h-3.5 w-3.5 sizing", () => {
    render(<ThemeToggle />);
    for (const label of ["System", "Light", "Dark"]) {
      const glyph = getRadio(label).querySelector("svg");
      expect(glyph).not.toBeNull();
      expect(glyph?.getAttribute("class") ?? "").toContain("h-3.5");
      expect(glyph?.getAttribute("class") ?? "").toContain("w-3.5");
    }
  });
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

describe("ThemeToggle selection", () => {
  test("selecting a non-active segment persists and applies it", () => {
    readStoredThemePreference.mockReturnValue("system");
    render(<ThemeToggle />);

    fireEvent.click(getRadio("Dark"));

    expect(writeStoredThemePreference).toHaveBeenCalledTimes(1);
    expect(writeStoredThemePreference).toHaveBeenCalledWith("dark");
    expect(applyThemePreference).toHaveBeenCalledTimes(1);
    expect(applyThemePreference).toHaveBeenCalledWith("dark");
  });

  test("clicking the already-active segment is a no-op", () => {
    readStoredThemePreference.mockReturnValue("system");
    render(<ThemeToggle />);

    fireEvent.click(getRadio("System"));

    expect(writeStoredThemePreference).not.toHaveBeenCalled();
    expect(applyThemePreference).not.toHaveBeenCalled();
  });
});
