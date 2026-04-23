import { describe, expect, test } from "bun:test";

import {
  INTERACTIVE_INTERFACES,
  INTERFACE_IDS,
  isInterfaceId,
  supportsHostProxy,
} from "../types.js";

describe("INTERFACE_IDS", () => {
  test("includes chrome-extension", () => {
    expect(
      (INTERFACE_IDS as readonly string[]).includes("chrome-extension"),
    ).toBe(true);
  });

  test("still includes macos and other existing interfaces", () => {
    for (const id of [
      "macos",
      "ios",
      "cli",
      "telegram",
      "phone",
      "vellum",
      "whatsapp",
      "slack",
      "email",
    ]) {
      expect((INTERFACE_IDS as readonly string[]).includes(id)).toBe(true);
    }
  });
});

describe("INTERACTIVE_INTERFACES", () => {
  test("does NOT include chrome-extension", () => {
    // Chrome extensions don't render SSE-backed prompter UI, so they must
    // stay out of the interactive set even though they have an InterfaceId.
    expect(INTERACTIVE_INTERFACES.has("chrome-extension" as never)).toBe(false);
  });

  test("still includes macos", () => {
    expect(INTERACTIVE_INTERFACES.has("macos")).toBe(true);
  });
});

describe("isInterfaceId", () => {
  test("returns true for chrome-extension", () => {
    expect(isInterfaceId("chrome-extension")).toBe(true);
  });

  test("returns true for macos", () => {
    expect(isInterfaceId("macos")).toBe(true);
  });

  test("returns false for unknown interface", () => {
    expect(isInterfaceId("safari-extension")).toBe(false);
  });
});

describe("supportsHostProxy", () => {
  // ── macOS: supports all four host proxy capabilities. ──
  test("macos returns true (no capability)", () => {
    expect(supportsHostProxy("macos")).toBe(true);
  });

  test("macos returns true for host_bash", () => {
    expect(supportsHostProxy("macos", "host_bash")).toBe(true);
  });

  test("macos returns true for host_file", () => {
    expect(supportsHostProxy("macos", "host_file")).toBe(true);
  });

  test("macos returns true for host_cu", () => {
    expect(supportsHostProxy("macos", "host_cu")).toBe(true);
  });

  test("macos returns true for host_browser", () => {
    expect(supportsHostProxy("macos", "host_browser")).toBe(true);
  });

  // ── chrome-extension: only host_browser. ──
  test("chrome-extension returns false (no capability)", () => {
    // Chrome extension does not support "any host proxy at all" — it only
    // supports host_browser, so the no-arg form must return false to keep
    // existing call sites that guard desktop-only behavior unchanged.
    expect(supportsHostProxy("chrome-extension")).toBe(false);
  });

  test("chrome-extension returns true for host_browser", () => {
    expect(supportsHostProxy("chrome-extension", "host_browser")).toBe(true);
  });

  test("chrome-extension returns false for host_bash", () => {
    expect(supportsHostProxy("chrome-extension", "host_bash")).toBe(false);
  });

  test("chrome-extension returns false for host_file", () => {
    expect(supportsHostProxy("chrome-extension", "host_file")).toBe(false);
  });

  test("chrome-extension returns false for host_cu", () => {
    expect(supportsHostProxy("chrome-extension", "host_cu")).toBe(false);
  });

  // ── Non-supporting interfaces: false in all forms. ──
  test("cli returns false (no capability)", () => {
    expect(supportsHostProxy("cli")).toBe(false);
  });

  test("cli returns false for host_bash", () => {
    expect(supportsHostProxy("cli", "host_bash")).toBe(false);
  });

  test("cli returns false for host_browser", () => {
    expect(supportsHostProxy("cli", "host_browser")).toBe(false);
  });

  test("telegram returns false (no capability)", () => {
    expect(supportsHostProxy("telegram")).toBe(false);
  });

  test("telegram returns false for host_browser", () => {
    expect(supportsHostProxy("telegram", "host_browser")).toBe(false);
  });

  test("vellum returns false (no capability)", () => {
    expect(supportsHostProxy("vellum")).toBe(false);
  });

  test("email returns false for host_browser", () => {
    expect(supportsHostProxy("email", "host_browser")).toBe(false);
  });
});
