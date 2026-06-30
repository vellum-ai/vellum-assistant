/**
 * Tests for `PluginIcon`: glyph defaulting by `external` and the `sm` / `md`
 * container sizing that matches `SkillIcon`.
 *
 * Mounted via `@testing-library/react` (happy-dom — see
 * `clients/web/test-setup.ts`).
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, render } from "@testing-library/react";

import { PluginIcon } from "@/domains/intelligence/components/plugins/plugin-icon.js";

afterEach(() => {
  cleanup();
});

const PACKAGE = "\u{1F4E6}"; // 📦
const PUZZLE = "\u{1F9E9}"; // 🧩

describe("PluginIcon", () => {
  test("defaults to 📦 when external", () => {
    const { container } = render(<PluginIcon external />);
    expect(container.textContent).toBe(PACKAGE);
  });

  test("defaults to 🧩 when not external", () => {
    const { container } = render(<PluginIcon />);
    expect(container.textContent).toBe(PUZZLE);
  });

  test("sm size renders an h-7 w-7 container", () => {
    const { container } = render(<PluginIcon size="sm" />);
    const span = container.querySelector("span");
    expect(span?.className).toContain("h-7");
    expect(span?.className).toContain("w-7");
  });

  test("md size renders an h-8 w-8 container", () => {
    const { container } = render(<PluginIcon size="md" />);
    const span = container.querySelector("span");
    expect(span?.className).toContain("h-8");
    expect(span?.className).toContain("w-8");
  });
});
