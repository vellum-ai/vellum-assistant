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
];

function paintTokens(root: HTMLElement) {
  for (const [name, value] of TOKEN_PROPERTIES) {
    root.style.setProperty(name, value);
  }
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
    expect(appearanceFromTokens(TOKENS, "stripe").variables?.borderRadius).toBe(
      "12px",
    );
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
});

describe("readAppearanceTokens", () => {
  test("resolves every token from the given root", () => {
    const root = document.createElement("div");
    paintTokens(root);
    document.body.appendChild(root);
    try {
      expect(readAppearanceTokens(root)).toEqual(TOKENS);
    } finally {
      root.remove();
    }
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
