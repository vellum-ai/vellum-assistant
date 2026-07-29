import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  buildWidgetStyle,
  buildWidgetStyleTag,
  readWidgetTokens,
  WIDGET_RAMP_DARK_MIRROR,
  WIDGET_TOKEN_PROPERTIES,
} from "@/utils/widget-tokens";

function applyTokens(css: string): HTMLStyleElement {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
  return style;
}

/**
 * Declare every allowlisted token with a value that names the property it was
 * declared on, so a snapshot reveals which variable each emitted name read
 * from.
 */
function applyIdentifiableTokens(): void {
  applyTokens(
    `:root{${WIDGET_TOKEN_PROPERTIES.map(
      (property) => `${property}:value-for${property}`,
    ).join(";")}}`,
  );
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

describe("WIDGET_RAMP_DARK_MIRROR", () => {
  test("pairs the 10-stop accents symmetrically from 100/950 to 500/600", () => {
    for (const [step, mirrored] of [
      ["100", "950"],
      ["200", "900"],
      ["300", "800"],
      ["400", "700"],
      ["500", "600"],
    ]) {
      // GIVEN an accent ramp, WHEN the pair is read in either direction
      // THEN both halves name each other.
      expect(WIDGET_RAMP_DARK_MIRROR.get(`--color-forest-${step}`)).toBe(
        `--color-forest-${mirrored}`,
      );
      expect(WIDGET_RAMP_DARK_MIRROR.get(`--color-forest-${mirrored}`)).toBe(
        `--color-forest-${step}`,
      );
    }
  });

  test("pairs the 11-stop neutrals from 50/950, leaving 500 on itself", () => {
    for (const [step, mirrored] of [
      ["50", "950"],
      ["100", "900"],
      ["200", "800"],
      ["300", "700"],
      ["400", "600"],
      ["500", "500"],
    ]) {
      expect(WIDGET_RAMP_DARK_MIRROR.get(`--color-stone-${step}`)).toBe(
        `--color-stone-${mirrored}`,
      );
      expect(WIDGET_RAMP_DARK_MIRROR.get(`--color-stone-${mirrored}`)).toBe(
        `--color-stone-${step}`,
      );
    }
  });

  test("covers every ramp variable and nothing else, and is an involution", () => {
    // GIVEN the allowlist split into ramp and semantic names
    const rampProperties = WIDGET_TOKEN_PROPERTIES.filter((property) =>
      property.startsWith("--color-"),
    );

    // THEN the mirror spans exactly the ramps — a missed stop would fall back
    // to reading itself and break the matched triple it belongs to.
    expect([...WIDGET_RAMP_DARK_MIRROR.keys()].sort()).toEqual(
      [...rampProperties].sort(),
    );

    // AND applying it twice is the identity, in both palette families.
    for (const [property, mirrored] of WIDGET_RAMP_DARK_MIRROR) {
      expect(WIDGET_RAMP_DARK_MIRROR.get(mirrored)).toBe(property);
      expect(rampProperties).toContain(mirrored);
    }
  });

  test("keeps a mirrored stop inside its own palette", () => {
    for (const [property, mirrored] of WIDGET_RAMP_DARK_MIRROR) {
      expect(mirrored.replace(/-\d+$/, "")).toBe(property.replace(/-\d+$/, ""));
    }
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

  test("passes every token through unchanged under the light scheme", () => {
    // GIVEN a host declaring every allowlisted token
    applyIdentifiableTokens();

    // WHEN the light snapshot is taken
    const tokens = readWidgetTokens(undefined, "light");

    // THEN each name carries its own declared value — ramps included.
    for (const property of WIDGET_TOKEN_PROPERTIES) {
      expect(tokens[property]).toBe(`value-for${property}`);
    }
  });

  test("emits each ramp variable with its mirrored stop's value under dark", () => {
    // GIVEN the same host declarations
    applyIdentifiableTokens();

    // WHEN the dark snapshot is taken
    const tokens = readWidgetTokens(undefined, "dark");

    // THEN a matched triple authored against the light reading inverts: the
    // 100 fill becomes the darkest stop and the 900 text becomes a light one.
    expect(tokens["--color-forest-100"]).toBe("value-for--color-forest-950");
    expect(tokens["--color-forest-600"]).toBe("value-for--color-forest-500");
    expect(tokens["--color-forest-900"]).toBe("value-for--color-forest-200");
    // AND the neutrals pair off their own 11-stop ramp, 500 onto itself.
    expect(tokens["--color-moss-50"]).toBe("value-for--color-moss-950");
    expect(tokens["--color-moss-500"]).toBe("value-for--color-moss-500");
    // AND the semantic tokens, which flip on their own, are untouched.
    expect(tokens["--surface-lift"]).toBe("value-for--surface-lift");
    expect(tokens["--content-default"]).toBe("value-for--content-default");
    expect(tokens["--system-positive-strong"]).toBe(
      "value-for--system-positive-strong",
    );
  });

  test("resolves every allowlisted name to a non-empty value in both schemes", () => {
    // GIVEN a host declaring every allowlisted token
    applyIdentifiableTokens();

    // THEN neither scheme drops a name: a mirrored source that resolved to
    // nothing would silently delete the declaration inside the frame.
    for (const colorScheme of ["light", "dark"] as const) {
      const tokens = readWidgetTokens(undefined, colorScheme);
      expect(Object.keys(tokens).sort()).toEqual(
        [...WIDGET_TOKEN_PROPERTIES].sort(),
      );
      for (const property of WIDGET_TOKEN_PROPERTIES) {
        expect(tokens[property]).not.toBe("");
      }
    }
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
    expect(buildWidgetStyle("dark").style).toContain(
      "--content-quiet:#8d99a5;",
    );
    // Every non-light theme (velvet included) declares the dark scheme.
    expect(buildWidgetStyle("velvet").style).toContain("color-scheme:dark");
    expect(buildWidgetStyle("light").style).toContain("color-scheme:light");
  });

  test("mirrors the ramps for dark-family themes and passes them through for light", () => {
    applyIdentifiableTokens();

    expect(buildWidgetStyle("light").style).toContain(
      "--color-forest-100:value-for--color-forest-100;",
    );
    for (const theme of ["dark", "velvet"]) {
      expect(buildWidgetStyle(theme).style).toContain(
        "--color-forest-100:value-for--color-forest-950;",
      );
    }
  });

  test("reports whether the host resolved any token", () => {
    // GIVEN a document whose stylesheet has not applied yet, every token
    // resolves to the empty string and the snapshot carries no values.
    const unresolved = buildWidgetStyle("light");
    expect(unresolved.resolved).toBe(false);
    expect(unresolved.style).toContain(":root{color-scheme:light;}");

    // WHEN the host's tokens land, the same read reports resolved.
    applyTokens(":root{--content-default:#24292e;}");
    const resolved = buildWidgetStyle("light");
    expect(resolved.resolved).toBe(true);
    expect(resolved.style).toContain("--content-default:#24292e;");
  });
});
