import { afterEach, describe, expect, test } from "bun:test";

import {
  appearanceFromTokens,
  buildStripeAppearance,
  readAppearanceTokens,
  withAlpha,
  type StripeAppearanceTokens,
} from "./stripe-appearance";

const TOKENS: StripeAppearanceTokens = {
  text: "#161616",
  textSecondary: "#71808E",
  placeholder: "#A9B2BB",
  surface: "#FFFFFF",
  field: "#F6F5F4",
  accent: "#467CC8",
  danger: "#DA491A",
  dangerText: "#DA491A",
  icon: "#71808E",
  radius: "12px",
};

const TOKEN_PROPERTIES: Array<[string, string]> = [
  ["--content-emphasised", TOKENS.text],
  ["--content-tertiary", TOKENS.textSecondary],
  ["--content-faint", TOKENS.placeholder],
  ["--surface-lift", TOKENS.surface],
  ["--surface-base", TOKENS.field],
  ["--system-info-strong", TOKENS.accent],
  ["--system-negative-strong", TOKENS.danger],
  ["--system-negative-on-weak", TOKENS.dangerText],
  ["--radius-lg", TOKENS.radius],
];

/** The variables that never come from a token, so they survive an empty read. */
const STATIC_VARIABLES = {
  fontFamily: '"DM Sans", system-ui, sans-serif',
  fontSizeBase: "15px",
  fontSizeSm: "11px",
  fontWeightMedium: "500",
  spacingUnit: "4px",
  spacingGridRow: "10px",
  spacingGridColumn: "10px",
  focusOutline: "none",
};

function paintTokens(root: HTMLElement) {
  for (const [name, value] of TOKEN_PROPERTIES) {
    root.style.setProperty(name, value);
  }
}

function withRoot(run: (root: HTMLElement) => void) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  try {
    run(root);
  } finally {
    root.remove();
  }
}

function stringValues(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(stringValues);
  }
  return [];
}

afterEach(() => {
  for (const [name] of TOKEN_PROPERTIES) {
    document.documentElement.style.removeProperty(name);
  }
});

describe("withAlpha", () => {
  test("expands a six digit hex", () => {
    expect(withAlpha("#467CC8", 0.14)).toBe("rgba(70, 124, 200, 0.14)");
  });

  test("expands a three digit hex by doubling each digit", () => {
    expect(withAlpha("#0af", 0.5)).toBe("rgba(0, 170, 255, 0.5)");
  });

  test("reads an rgb() color", () => {
    expect(withAlpha("rgb(70, 124, 200)", 0.14)).toBe(
      "rgba(70, 124, 200, 0.14)",
    );
  });

  test("replaces the alpha of an rgba() color", () => {
    expect(withAlpha("rgba(70, 124, 200, 0.9)", 0.14)).toBe(
      "rgba(70, 124, 200, 0.14)",
    );
  });

  test("returns unparseable input unchanged", () => {
    expect(withAlpha("not-a-color", 0.14)).toBe("not-a-color");
    expect(withAlpha("", 0.14)).toBe("");
  });
});

describe("appearanceFromTokens", () => {
  test("passes the base theme through and floats the labels", () => {
    expect(appearanceFromTokens(TOKENS, "night").theme).toBe("night");
    const light = appearanceFromTokens(TOKENS, "stripe");
    expect(light.theme).toBe("stripe");
    expect(light.labels).toBe("floating");
  });

  test("uses the radius-lg token value for the field radius", () => {
    withRoot((root) => {
      paintTokens(root);
      root.style.setProperty("--radius-lg", "10px");
      const appearance = appearanceFromTokens(
        readAppearanceTokens(root),
        "stripe",
      );
      expect(appearance.variables?.borderRadius).toBe("10px");
    });
  });

  test("outlines a focused field with the accent and a 14% accent ring", () => {
    const appearance = appearanceFromTokens(TOKENS, "stripe");
    const ring = "0 0 0 3px rgba(70, 124, 200, 0.14)";
    expect(appearance.variables?.focusBoxShadow).toBe(ring);
    expect(appearance.rules?.[".Input:focus"]).toMatchObject({
      border: "1px solid #467CC8",
      boxShadow: ring,
    });
  });

  test("maps the token palette onto the Stripe color variables", () => {
    const appearance = appearanceFromTokens(TOKENS, "stripe");
    expect(appearance.variables).toMatchObject({
      colorText: TOKENS.text,
      colorTextSecondary: TOKENS.textSecondary,
      colorTextPlaceholder: TOKENS.placeholder,
      colorBackground: TOKENS.surface,
      colorPrimary: TOKENS.accent,
      colorDanger: TOKENS.danger,
      colorIcon: TOKENS.icon,
    });
    expect(appearance.rules?.[".Input"]).toMatchObject({
      backgroundColor: TOKENS.field,
    });
    expect(appearance.rules?.[".Error"]).toMatchObject({
      color: TOKENS.dangerText,
    });
  });

  test("drops every token-driven value when nothing resolves", () => {
    const appearance = appearanceFromTokens({}, "night");
    expect(appearance.variables).toEqual(STATIC_VARIABLES);
    expect(appearance.rules).toEqual({
      ".Input": {
        border: "1px solid transparent",
        boxShadow: "none",
        padding: "9px 14px",
        transition:
          "background-color 120ms, border-color 120ms, box-shadow 120ms",
      },
      ".Input--invalid": {
        boxShadow: "none",
      },
      ".Label": {
        fontSize: "11px",
        fontWeight: "500",
      },
      ".Error": {
        fontSize: "12.5px",
      },
    });
  });

  test("never hands Stripe an empty or half-built value", () => {
    // The input is a `Partial`, so `""` is representable even though the token
    // read never produces one: an empty accent would build `"0 0 0 3px "`.
    const emptyTokens = Object.fromEntries(
      Object.keys(TOKENS).map((key) => [key, ""]),
    ) as Partial<StripeAppearanceTokens>;
    for (const tokens of [
      {},
      emptyTokens,
      { text: TOKENS.text, danger: TOKENS.danger },
    ]) {
      for (const value of stringValues(appearanceFromTokens(tokens, "night"))) {
        expect(value).not.toBe("");
        expect(value).not.toMatch(/\s$/);
      }
    }
  });

  test("keeps the tokens that did resolve when only some are painted", () => {
    const appearance = appearanceFromTokens(
      { text: TOKENS.text, danger: TOKENS.danger },
      "stripe",
    );
    expect(appearance.variables).toEqual({
      ...STATIC_VARIABLES,
      colorText: TOKENS.text,
      colorDanger: TOKENS.danger,
    });
    expect(appearance.rules?.[".Input--invalid"]).toEqual({
      border: `1px solid ${TOKENS.danger}`,
      boxShadow: "none",
    });
    expect(appearance.rules?.[".Input:focus"]).toBeUndefined();
    expect(appearance.rules?.[".Label--invalid"]).toEqual({
      color: TOKENS.danger,
    });
  });
});

describe("readAppearanceTokens", () => {
  test("resolves every token from the given root", () => {
    withRoot((root) => {
      paintTokens(root);
      expect(readAppearanceTokens(root)).toEqual(TOKENS);
    });
  });

  test("leaves out a token that resolves to nothing", () => {
    withRoot((root) => {
      root.style.setProperty("--content-emphasised", TOKENS.text);
      const tokens = readAppearanceTokens(root);
      expect(tokens.text).toBe(TOKENS.text);
      expect(tokens.surface).toBeUndefined();
      expect(tokens.accent).toBeUndefined();
      expect(tokens.radius).toBeUndefined();
    });
  });

  test("defaults to the document element", () => {
    paintTokens(document.documentElement);
    expect(readAppearanceTokens()).toEqual(TOKENS);
  });
});

describe("buildStripeAppearance", () => {
  test("uses the stripe base for light and the night base otherwise", () => {
    paintTokens(document.documentElement);
    expect(buildStripeAppearance("light").theme).toBe("stripe");
    expect(buildStripeAppearance("dark").theme).toBe("night");
    expect(buildStripeAppearance("velvet").theme).toBe("night");
  });

  test("reads the live token values", () => {
    paintTokens(document.documentElement);
    expect(buildStripeAppearance("light").variables?.colorPrimary).toBe(
      TOKENS.accent,
    );
  });
});
