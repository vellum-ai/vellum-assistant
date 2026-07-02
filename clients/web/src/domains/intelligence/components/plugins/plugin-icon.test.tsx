/**
 * Tests for `PluginIcon`: the bundled `iconSrc` image (and its `onError`
 * fallback), the author `icon` emoji, glyph defaulting by `external`, and the
 * `sm` / `md` container sizing that matches `SkillIcon`.
 *
 * Mounted via `@testing-library/react` (happy-dom — see
 * `clients/web/test-setup.ts`); fires a real `error` event on the `<img>` to
 * exercise the `useState`-driven fallback.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";

import { PluginIcon } from "@/domains/intelligence/components/plugins/plugin-icon.js";

afterEach(() => {
  cleanup();
});

const PACKAGE = "\u{1F4E6}"; // 📦
const PUZZLE = "\u{1F9E9}"; // 🧩

describe("PluginIcon", () => {
  test("renders a lazy, decorative <img> when iconSrc is provided", () => {
    const { container } = render(<PluginIcon iconSrc="/x.png" icon="🚀" />);
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("/x.png");
    expect(img!.getAttribute("loading")).toBe("lazy");
    expect(img!.getAttribute("alt")).toBe("");
    expect(img!.getAttribute("aria-hidden")).toBe("true");
    // The image wins over the emoji, so no glyph text renders alongside it.
    expect(container.textContent).toBe("");
  });

  test("falls back to the icon emoji when the image errors", () => {
    const { container } = render(<PluginIcon iconSrc="/x.png" icon="🚀" />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("🚀");
  });

  test("falls back to 📦 when the image errors, no icon, external", () => {
    const { container } = render(<PluginIcon iconSrc="/x.png" external />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe(PACKAGE);
  });

  test("falls back to 🧩 when the image errors, no icon, not external", () => {
    const { container } = render(<PluginIcon iconSrc="/x.png" />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe(PUZZLE);
  });

  test("renders the provided icon emoji", () => {
    const { container } = render(<PluginIcon icon="🚀" />);
    expect(container.textContent).toBe("🚀");
  });

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
