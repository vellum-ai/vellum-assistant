import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  buildWidgetStyle,
  buildWidgetStyleTag,
  readWidgetTokens,
  WIDGET_TOKEN_PROPERTIES,
} from "@/utils/widget-tokens";

function applyTokens(css: string): HTMLStyleElement {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
  return style;
}

afterEach(() => {
  for (const style of Array.from(document.head.querySelectorAll("style"))) {
    style.remove();
  }
});

describe("WIDGET_TOKEN_PROPERTIES", () => {
  test("covers surfaces, content, borders, system, fonts, radius and palettes", () => {
    for (const property of [
      "--surface-lift",
      "--content-default",
      "--border-subtle",
      "--system-positive-strong",
      "--font-sans",
      "--font-mono",
      "--font-serif",
      "--radius-md",
      "--color-moss-500",
      "--color-stone-50",
      "--color-forest-700",
      "--color-emerald-300",
      "--color-danger-600",
      "--color-amber-200",
    ]) {
      expect(WIDGET_TOKEN_PROPERTIES).toContain(property);
    }
  });

  test("its palette steps match the ramps declared in the design-library tokens", () => {
    // GIVEN the design system's own ramp declarations
    const tokensCss = readFileSync(
      join(
        import.meta.dir,
        "../../../../packages/design-library/src/tokens.css",
      ),
      "utf8",
    );
    const declared = new Set(
      Array.from(
        tokensCss.matchAll(
          /(--color-(?:moss|stone|forest|emerald|danger|amber)-\d+)\s*:/g,
        ),
        (match) => match[1],
      ),
    );

    // WHEN the allowlist's palette entries are compared against them
    const allowlisted = WIDGET_TOKEN_PROPERTIES.filter((property) =>
      property.startsWith("--color-"),
    );

    // THEN the two agree exactly — an allowlisted step that the tokens file
    // never declares resolves to nothing inside the frame, which silently
    // drops the widget's fill/color declaration.
    expect(declared.size).toBeGreaterThan(0);
    expect([...allowlisted].sort()).toEqual([...declared].sort());
  });
});

describe("readWidgetTokens", () => {
  test("reads resolved values and skips properties that resolve empty", () => {
    // GIVEN a host document declaring two of the allowlisted tokens
    applyTokens(":root{--surface-lift:#ffffff;--content-default:#24292e;}");

    // WHEN the tokens are snapshotted
    const tokens = readWidgetTokens();

    // THEN only the declared ones are present
    expect(tokens["--surface-lift"]).toBe("#ffffff");
    expect(tokens["--content-default"]).toBe("#24292e");
    expect(tokens["--color-amber-200"]).toBeUndefined();
  });

  test("strips characters that could terminate the declaration", () => {
    applyTokens(':root{--font-sans:"DM Sans", system-ui;}');
    applyTokens(":root{--surface-lift:#fff}</style><script>x</script>;}");

    const tokens = readWidgetTokens();

    expect(tokens["--font-sans"]).toBe('"DM Sans", system-ui');
    expect(tokens["--surface-lift"]).not.toContain("<");
    expect(tokens["--surface-lift"]).not.toContain("}");
  });
});

describe("buildWidgetStyleTag", () => {
  test("emits a :root block plus the widget base styles", () => {
    const tag = buildWidgetStyleTag(
      {
        "--surface-lift": "#ffffff",
        "--font-sans": '"DM Sans", system-ui',
      },
      "dark",
    );

    expect(tag.startsWith("<style>:root{color-scheme:dark;")).toBe(true);
    expect(tag).toContain("--surface-lift:#ffffff;");
    expect(tag).toContain('--font-sans:"DM Sans", system-ui;');
    // Base styles keep the widget transparent and margin-free so the host
    // background shows through and the height reporter measures content.
    expect(tag).toContain("background:transparent");
    expect(tag).toContain("margin:0");
    expect(tag).toContain("font-family:var(--font-sans)");
    expect(tag).toContain("color:var(--content-default)");
    expect(tag).toContain("box-sizing:border-box");
    expect(tag.endsWith("</style>")).toBe(true);
  });

  test("still emits base styles when no token resolves", () => {
    const tag = buildWidgetStyleTag({}, "light");
    expect(tag).toContain(":root{color-scheme:light;}");
    expect(tag).toContain("background:transparent");
  });
});

describe("buildWidgetStyle", () => {
  test("snapshots the live document in one step", () => {
    applyTokens(":root{--content-quiet:#8d99a5;}");
    expect(buildWidgetStyle("dark")).toContain("--content-quiet:#8d99a5;");
    // Every non-light theme (velvet included) declares the dark scheme.
    expect(buildWidgetStyle("velvet")).toContain("color-scheme:dark");
    expect(buildWidgetStyle("light")).toContain("color-scheme:light");
  });
});
