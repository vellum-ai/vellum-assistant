import { describe, expect, test } from "bun:test";

import {
  NOTIFICATION_AVATAR_ACCENT_MIX,
  NOTIFICATION_AVATAR_FALLBACK_DISC_HEX,
  NOTIFICATION_AVATAR_INSET,
  NOTIFICATION_AVATAR_SIZE,
  notificationAvatarDiscHex,
  notificationAvatarSvg,
} from "../notification-avatar.js";

/** The spec's mix, written out again so the module cannot grade its own homework. */
function mixIntoWhite(hex: string, amount: number): string {
  const rgb = parseInt(hex.slice(1), 16);
  const channel = (shift: number) =>
    Math.round(255 * (1 - amount) + ((rgb >> shift) & 0xff) * amount)
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  return `#${channel(16)}${channel(8)}${channel(0)}`;
}

function attributes(tag: string, svg: string): Record<string, string> {
  const match = svg.match(new RegExp(`<${tag}\\s([^>]*)/>`));
  expect(match).not.toBeNull();
  const out: Record<string, string> = {};
  for (const [, name, value] of match![1]!.matchAll(/([\w:-]+)="([^"]*)"/g)) {
    out[name!] = value!;
  }
  return out;
}

function countOf(tag: string, svg: string): number {
  return svg.split(`<${tag}`).length - 1;
}

const PNG_BASE64 = "iVBORw0KGgo=";

describe("notificationAvatarDiscHex", () => {
  test("mixes the accent into white", () => {
    expect(notificationAvatarDiscHex("#E9642F")).toBe("#FCE9E2");
    expect(notificationAvatarDiscHex("#E9642F")).toBe(
      mixIntoWhite("#E9642F", NOTIFICATION_AVATAR_ACCENT_MIX),
    );
  });

  test("is case insensitive and always returns uppercase #RRGGBB", () => {
    expect(notificationAvatarDiscHex("#e9642f")).toBe("#FCE9E2");
  });

  test("keeps white white and lifts black to near white", () => {
    expect(notificationAvatarDiscHex("#FFFFFF")).toBe("#FFFFFF");
    expect(notificationAvatarDiscHex("#000000")).toBe(
      mixIntoWhite("#000000", NOTIFICATION_AVATAR_ACCENT_MIX),
    );
  });

  test.each([
    ["null", null],
    ["short form", "#abc"],
    ["no hash", "e9642f"],
    ["garbage", "not a colour"],
    ["empty", ""],
  ])("falls back to the neutral disc for %s", (_label, value) => {
    expect(notificationAvatarDiscHex(value as string | null)).toBe(
      NOTIFICATION_AVATAR_FALLBACK_DISC_HEX,
    );
  });
});

describe("notificationAvatarSvg", () => {
  test("draws one disc and one inset avatar at the default size", () => {
    const svg = notificationAvatarSvg({
      innerPngBase64: PNG_BASE64,
      accentHex: "#E9642F",
    });

    expect(countOf("svg", svg)).toBe(1);
    expect(countOf("circle", svg)).toBe(1);
    expect(countOf("image", svg)).toBe(1);

    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg).toContain(`width="256" height="256"`);
    expect(svg).toContain(`viewBox="0 0 256 256"`);

    const circle = attributes("circle", svg);
    expect(circle).toMatchObject({ cx: "128", cy: "128", r: "128" });
    expect(circle.fill).toBe("#FCE9E2");

    const inset = NOTIFICATION_AVATAR_SIZE * NOTIFICATION_AVATAR_INSET;
    const inner = NOTIFICATION_AVATAR_SIZE - 2 * inset;
    const image = attributes("image", svg);
    expect(Number(image.x)).toBeCloseTo(inset, 3);
    expect(Number(image.y)).toBeCloseTo(inset, 3);
    expect(Number(image.width)).toBeCloseTo(inner, 3);
    expect(Number(image.height)).toBeCloseTo(inner, 3);
    expect(image.href).toBe(`data:image/png;base64,${PNG_BASE64}`);
    expect(image["xlink:href"]).toBe(image.href);
  });

  test("scales the geometry to a custom size", () => {
    const svg = notificationAvatarSvg({
      innerPngBase64: PNG_BASE64,
      accentHex: "#E9642F",
      size: 100,
    });

    expect(svg).toContain(`width="100" height="100"`);
    expect(attributes("circle", svg)).toMatchObject({
      cx: "50",
      cy: "50",
      r: "50",
    });
    expect(attributes("image", svg)).toMatchObject({
      x: "11",
      y: "11",
      width: "78",
      height: "78",
    });
  });

  test("paints the fallback disc when there is no accent", () => {
    const svg = notificationAvatarSvg({
      innerPngBase64: PNG_BASE64,
      accentHex: null,
    });
    expect(attributes("circle", svg).fill).toBe(
      NOTIFICATION_AVATAR_FALLBACK_DISC_HEX,
    );
  });
});
