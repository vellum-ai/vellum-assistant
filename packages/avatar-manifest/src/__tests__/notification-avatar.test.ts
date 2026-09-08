import { describe, expect, test } from "bun:test";

import {
  NOTIFICATION_AVATAR_FALLBACK_DISC_HEX,
  NOTIFICATION_AVATAR_INSET,
  NOTIFICATION_AVATAR_MAX_BYTES,
  NOTIFICATION_AVATAR_MAX_LOCAL_BYTES,
  NOTIFICATION_AVATAR_SIZE,
  NOTIFICATION_AVATAR_SPEC_VERSION,
  notificationAvatarDiscHex,
  notificationAvatarGeometry,
  notificationAvatarSvg,
} from "../notification-avatar.js";

function allAttributes(tag: string, svg: string): Record<string, string>[] {
  return [...svg.matchAll(new RegExp(`<${tag}\\s([^>]*)/>`, "g"))].map(
    (match) => {
      const out: Record<string, string> = {};
      for (const [, name, value] of match[1]!.matchAll(
        /([\w:-]+)="([^"]*)"/g,
      )) {
        out[name!] = value!;
      }
      return out;
    },
  );
}

function attributes(tag: string, svg: string): Record<string, string> {
  const all = allAttributes(tag, svg);
  expect(all.length).toBeGreaterThan(0);
  return all[0]!;
}

function countOf(tag: string, svg: string): number {
  return svg.split(`<${tag}`).length - 1;
}

const PNG_BASE64 = "iVBORw0KGgo=";

describe("notificationAvatarDiscHex", () => {
  test("mixes the accent into white", () => {
    expect(notificationAvatarDiscHex("#E9642F")).toBe("#FCE9E2");
    expect(notificationAvatarDiscHex("#4C9B50")).toBe("#E6F1E7");
  });

  test("is case insensitive and always returns uppercase #RRGGBB", () => {
    expect(notificationAvatarDiscHex("#e9642f")).toBe("#FCE9E2");
  });

  test("keeps white white and lifts black to near white", () => {
    expect(notificationAvatarDiscHex("#FFFFFF")).toBe("#FFFFFF");
    expect(notificationAvatarDiscHex("#000000")).toBe("#DBDBDB");
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

  test("cover-crops a non-square raster and clips it to the disc", () => {
    // The builder never sees the source dimensions, so what makes a 1024x512
    // upload fill the square instead of letterboxing is the pair of attributes
    // asserted here.
    const svg = notificationAvatarSvg({
      innerPngBase64: PNG_BASE64,
      accentHex: "#E9642F",
    });

    const image = attributes("image", svg);
    expect(image.preserveAspectRatio).toBe("xMidYMid slice");

    const clipRef = image["clip-path"]!;
    const clipId = clipRef.match(/^url\(#([\w-]+)\)$/)?.[1];
    expect(clipId).toBeTruthy();
    expect(svg).toContain(`<clipPath id="${clipId}">`);

    // The clip circle carries the disc geometry and nothing else, so the
    // painted disc and the boundary can never drift apart.
    const [disc, clip] = allAttributes("circle", svg);
    expect(clip).toEqual({ cx: "128", cy: "128", r: "128" });
    expect(disc).toMatchObject({ cx: "128", cy: "128", r: "128" });
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

  test("carries a non-PNG inner raster with its own media type", () => {
    const svg = notificationAvatarSvg({
      innerPngBase64: PNG_BASE64,
      innerMediaType: "image/jpeg",
      accentHex: "#E9642F",
    });

    const image = attributes("image", svg);
    expect(image.href).toBe(`data:image/jpeg;base64,${PNG_BASE64}`);
    expect(image["xlink:href"]).toBe(image.href);
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

describe("notificationAvatarGeometry", () => {
  test("derives the disc, the border and the avatar edge from the size", () => {
    expect(notificationAvatarGeometry(100)).toEqual({
      radius: 50,
      offset: 11,
      inner: 78,
    });
  });

  test("measures the default size when given none", () => {
    expect(notificationAvatarGeometry()).toEqual(
      notificationAvatarGeometry(NOTIFICATION_AVATAR_SIZE),
    );
  });

  test("is the geometry the SVG is drawn with", () => {
    const size = 100;
    const { radius, offset, inner } = notificationAvatarGeometry(size);
    const svg = notificationAvatarSvg({
      innerPngBase64: PNG_BASE64,
      accentHex: null,
      size,
    });

    expect(attributes("circle", svg)).toMatchObject({
      cx: String(radius),
      cy: String(radius),
      r: String(radius),
    });
    expect(attributes("image", svg)).toMatchObject({
      x: String(offset),
      y: String(offset),
      width: String(inner),
      height: String(inner),
    });
  });
});

describe("the transport contract", () => {
  test("caps a notification PNG at 128 KB for the platform sync", () => {
    expect(NOTIFICATION_AVATAR_MAX_BYTES).toBe(128 * 1024);
  });

  test("gives the local desktop path a looser cap of its own", () => {
    expect(NOTIFICATION_AVATAR_MAX_LOCAL_BYTES).toBe(512 * 1024);
    expect(NOTIFICATION_AVATAR_MAX_LOCAL_BYTES).toBeGreaterThan(
      NOTIFICATION_AVATAR_MAX_BYTES,
    );
  });

  test("stamps the drawing with a spec version", () => {
    expect(Number.isInteger(NOTIFICATION_AVATAR_SPEC_VERSION)).toBe(true);
    expect(NOTIFICATION_AVATAR_SPEC_VERSION).toBeGreaterThan(0);
  });
});
