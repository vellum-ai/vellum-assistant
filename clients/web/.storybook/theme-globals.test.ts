import { describe, expect, test } from "bun:test";

import {
  DEFAULT_THEME,
  themeFromGlobalsPayload,
  themeFromLastGlobalsEvent,
} from "./theme-globals";

describe("themeFromGlobalsPayload", () => {
  test("reads the theme the toolbar selected", () => {
    expect(themeFromGlobalsPayload({ globals: { theme: "velvet" } })).toBe(
      "velvet",
    );
  });

  test("falls back when the payload carries no theme", () => {
    expect(themeFromGlobalsPayload({ globals: {} })).toBe(DEFAULT_THEME);
    expect(themeFromGlobalsPayload({})).toBe(DEFAULT_THEME);
    expect(themeFromGlobalsPayload(undefined)).toBe(DEFAULT_THEME);
    expect(themeFromGlobalsPayload(null)).toBe(DEFAULT_THEME);
    expect(themeFromGlobalsPayload("velvet")).toBe(DEFAULT_THEME);
  });

  test("falls back when the theme is not a string", () => {
    expect(themeFromGlobalsPayload({ globals: { theme: 3 } })).toBe(
      DEFAULT_THEME,
    );
  });
});

describe("themeFromLastGlobalsEvent", () => {
  test("reads the first argument of the replayed event", () => {
    expect(themeFromLastGlobalsEvent([{ globals: { theme: "dark" } }])).toBe(
      "dark",
    );
  });

  test("falls back when no event has been replayed", () => {
    expect(themeFromLastGlobalsEvent(undefined)).toBe(DEFAULT_THEME);
    expect(themeFromLastGlobalsEvent([])).toBe(DEFAULT_THEME);
  });
});
