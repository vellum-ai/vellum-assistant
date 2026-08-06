import { afterEach, describe, expect, test } from "bun:test";

import {
  applyWorkspaceThemeTokens,
  readableOnColor,
  resolveThemeCssVars,
  WORKSPACE_THEME_CSS_VARS,
} from "./workspace-theme-tokens";

describe("resolveThemeCssVars", () => {
  test("returns no vars for undefined tokens", () => {
    expect(resolveThemeCssVars(undefined)).toEqual({});
  });

  test("fans a single token out to its full css-var group", () => {
    const vars = resolveThemeCssVars({ text: "#f2e4d4" });
    expect(vars["--foreground"]).toBe("#f2e4d4");
    expect(vars["--content-default"]).toBe("#f2e4d4");
    expect(vars["--content-emphasised"]).toBe("#f2e4d4");
    expect(vars["--content-strong"]).toBe("#f2e4d4");
  });

  test("maps background across the base surface group", () => {
    const vars = resolveThemeCssVars({ background: "#1c1512" });
    expect(vars["--background"]).toBe("#1c1512");
    expect(vars["--surface-base"]).toBe("#1c1512");
    expect(vars["--surface-sunken"]).toBe("#1c1512");
  });

  test("maps the user bubble tokens to dedicated vars", () => {
    const vars = resolveThemeCssVars({
      userBubbleBackground: "#26201a",
      userBubbleText: "#efe3d2",
    });
    expect(vars["--user-bubble-bg"]).toBe("#26201a");
    expect(vars["--user-bubble-text"]).toBe("#efe3d2");
  });

  test("assistant bubble tokens are accepted but not applied (deferred)", () => {
    const vars = resolveThemeCssVars({
      assistantBubbleBackground: "#33202a",
      assistantBubbleText: "#ffd7e4",
    });
    expect(vars).toEqual({});
  });

  test("ignores empty-string token values", () => {
    const vars = resolveThemeCssVars({ accent: "", background: "#000000" });
    expect(vars["--primary-base"]).toBeUndefined();
    expect(vars["--background"]).toBe("#000000");
  });

  test("derives a legible on-primary text color for a light accent", () => {
    const vars = resolveThemeCssVars({ accent: "#ffffff" });
    expect(vars["--primary-base"]).toBe("#ffffff");
    expect(vars["--content-inset"]).toBe("#17191c");
  });

  test("derives a legible on-primary text color for a dark accent", () => {
    const vars = resolveThemeCssVars({ accent: "#1a1a1a" });
    expect(vars["--content-inset"]).toBe("#fdfdfc");
  });

  test("does not touch on-primary text when accent is unset", () => {
    const vars = resolveThemeCssVars({ background: "#000000" });
    expect(vars["--content-inset"]).toBeUndefined();
  });
});

describe("readableOnColor", () => {
  test("returns dark text on light fills and light text on dark fills", () => {
    expect(readableOnColor("#ffffff")).toBe("#17191c");
    expect(readableOnColor("#000000")).toBe("#fdfdfc");
    expect(readableOnColor("#ffd700")).toBe("#17191c");
    expect(readableOnColor("#4b0082")).toBe("#fdfdfc");
  });
});

describe("applyWorkspaceThemeTokens", () => {
  afterEach(() => {
    for (const cssVar of WORKSPACE_THEME_CSS_VARS) {
      document.documentElement.style.removeProperty(cssVar);
    }
  });

  test("sets the resolved vars on the document root", () => {
    applyWorkspaceThemeTokens({ accent: "#e8a04c" });
    expect(
      document.documentElement.style.getPropertyValue("--primary-base"),
    ).toBe("#e8a04c");
  });

  test("clears a previously-set var when the token is removed", () => {
    applyWorkspaceThemeTokens({ accent: "#e8a04c" });
    applyWorkspaceThemeTokens({ background: "#111111" });
    expect(
      document.documentElement.style.getPropertyValue("--primary-base"),
    ).toBe("");
    expect(
      document.documentElement.style.getPropertyValue("--background"),
    ).toBe("#111111");
  });

  test("clears all overrides when passed undefined", () => {
    applyWorkspaceThemeTokens({ text: "#ffffff", background: "#000000" });
    applyWorkspaceThemeTokens(undefined);
    for (const cssVar of WORKSPACE_THEME_CSS_VARS) {
      expect(document.documentElement.style.getPropertyValue(cssVar)).toBe("");
    }
  });
});
