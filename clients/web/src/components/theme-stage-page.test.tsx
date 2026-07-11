/**
 * Tests for the theme stage (`/assistant/theme-stage/:view`).
 *
 * Covers:
 * - `parseThemeStageView` / `parseThemeStageTokens` URL parsing (tolerant of
 *   malformed payloads).
 * - Both views render their compositions.
 * - Workspace tokens from `?tokens=` land on the document root via
 *   `applyWorkspaceThemeTokens`, and clear on unmount.
 * - The ready sentinel is written to `document.title` once fonts settle.
 */

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";

import { MemoryRouter, Route, Routes } from "react-router";

import { WORKSPACE_THEME_CSS_VARS } from "@/domains/settings/utils/workspace-theme-tokens";

// The stage bootstraps the device base theme itself (standalone route); the
// real hook reads the feature-flag store, which is irrelevant here.
mock.module("@/hooks/use-app-theme", () => ({
  useAppTheme: () => undefined,
}));

const {
  parseThemeStageTokens,
  parseThemeStageView,
  THEME_STAGE_READY_TITLE,
  ThemeStagePage,
} = await import("./theme-stage-page");

function renderStage(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/assistant/theme-stage/:view" element={<ThemeStagePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  document.title = "";
  for (const cssVar of WORKSPACE_THEME_CSS_VARS) {
    document.documentElement.style.removeProperty(cssVar);
  }
});

describe("parseThemeStageView", () => {
  test("defaults unknown views to sampler", () => {
    expect(parseThemeStageView("chat")).toBe("chat");
    expect(parseThemeStageView("sampler")).toBe("sampler");
    expect(parseThemeStageView("bogus")).toBe("sampler");
    expect(parseThemeStageView(undefined)).toBe("sampler");
  });
});

describe("parseThemeStageTokens", () => {
  test("parses a JSON object of string values", () => {
    expect(parseThemeStageTokens('{"accent":"#e8a04c"}')).toEqual({
      accent: "#e8a04c",
    });
  });

  test("drops non-string values and tolerates malformed payloads", () => {
    expect(parseThemeStageTokens('{"accent":"#fff","depth":3}')).toEqual({
      accent: "#fff",
    });
    expect(parseThemeStageTokens("not json")).toBeUndefined();
    expect(parseThemeStageTokens('["#fff"]')).toBeUndefined();
    expect(parseThemeStageTokens(null)).toBeUndefined();
  });
});

describe("ThemeStagePage", () => {
  test("renders the sampler by default and applies URL tokens to the root", () => {
    const { getByTestId } = renderStage(
      "/assistant/theme-stage/sampler?tokens=%7B%22accent%22%3A%22%23e8a04c%22%7D",
    );
    expect(getByTestId("theme-stage-sampler")).toBeTruthy();
    expect(
      document.documentElement.style.getPropertyValue("--primary-base"),
    ).toBe("#e8a04c");
  });

  test("renders the chat view with the staged conversation", () => {
    const { getByTestId, getByText } = renderStage(
      "/assistant/theme-stage/chat",
    );
    expect(getByTestId("theme-stage-chat")).toBeTruthy();
    expect(
      getByText("Perfect. Send it to the team in the morning."),
    ).toBeTruthy();
  });

  test("clears applied tokens on unmount", () => {
    const { unmount } = renderStage(
      "/assistant/theme-stage/sampler?tokens=%7B%22background%22%3A%22%23111111%22%7D",
    );
    expect(
      document.documentElement.style.getPropertyValue("--background"),
    ).toBe("#111111");
    unmount();
    expect(
      document.documentElement.style.getPropertyValue("--background"),
    ).toBe("");
  });

  test("sets the ready sentinel title after fonts settle", async () => {
    renderStage("/assistant/theme-stage/chat");
    await waitFor(() => {
      expect(document.title).toBe(THEME_STAGE_READY_TITLE);
    });
  });
});
