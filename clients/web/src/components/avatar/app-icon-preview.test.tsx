/**
 * Tests for `AppIconPreview`.
 *
 * The preview stands in for a 1024px PNG nobody can load in the web app, so
 * what is worth asserting is the composition it claims to reproduce: the eye
 * pair centered on the field and fitted to this style's share of it, the field
 * painted in the trait color, every bundled eye style drawing something, and an
 * id the catalog does not carry degrading to the bare field instead of
 * throwing.
 *
 * The yardstick is {@link SAMPLED_EYE_BOUNDS}: fixed numbers, arrived at by a
 * method the component shares no code with. The transform the component
 * rendered is applied to those bounds, so the assertions describe where the
 * artwork lands on the icon, and neither the component nor the bounding-box
 * parser it frames with can satisfy them by agreeing with itself.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { AppIconPreview } from "@/components/avatar/app-icon-preview";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import { pathBBox, unionBBox, type BBox } from "@/utils/eye-bbox";
import type { CharacterComponents } from "@/types/avatar";

const SIZE = 128;
const GREEN_HEX = "#4C9B50";

/** A wide pair and a rounder one, the two ends of what the framing must fit. */
const WIDE_EYE_STYLE = "grumpy";
const ROUND_EYE_STYLE = "gentle";

/** The pair `clients/ios/App/App/AppIcon.icon` draws, at half the icon. */
const PRIMARY_EYE_STYLE = "quirky";

/** A style the span table frames narrower than the default. */
const NARROW_EYE_STYLE = "bashful";

/**
 * Union bounds of each bundled eye style's artwork, in its own path units.
 *
 * Ground truth, measured by walking every curve at 40,000 points and keeping
 * the extremes, which is a different method from the extrema solving the
 * component's framing goes through and is close to what a rasterizer reports.
 * Regenerate these numbers, do not adjust them to fit, if the bundled art
 * changes: they are what says the framing is right rather than merely
 * self-consistent.
 */
const SAMPLED_EYE_BOUNDS: Record<string, BBox> = {
  grumpy: { x: 90.5841, y: 226.908, w: 417.6578, h: 91.859 },
  angry: { x: 151, y: 267, w: 397.822, h: 130.949 },
  curious: { x: 125.514, y: 334.425, w: 276.793, h: 160.893 },
  goofy: { x: 182.018, y: 286.568, w: 285.06, h: 206.844 },
  surprised: { x: 150.422, y: 84.8232, w: 340.96, h: 163.0838 },
  bashful: { x: 276, y: 280, w: 241.001, h: 115.273 },
  gentle: { x: 176.504, y: 247.329, w: 253.453, h: 221.736 },
  quirky: { x: 218.6091, y: 266.3528, w: 231.3574, h: 171.1384 },
  dazed: { x: 153.352, y: 224.744, w: 382.872, h: 160.174 },
};

/** Fraction of the icon a pair spans when the table below leaves it alone. */
const DEFAULT_EYE_SPAN_FRACTION = 0.5;

/**
 * Fraction of the icon each eye style's pair is fitted to, pinned as literals.
 *
 * `clients/ios/scripts/__tests__/generate-avatar-icons.test.ts` pins the same
 * numbers against a rasterized measurement of the same artwork, so the preview
 * and the shipped PNGs cannot drift apart across the bundle boundary between
 * them.
 */
const EXPECTED_EYE_SPAN_FRACTION: Record<string, number> = {
  grumpy: 0.5,
  angry: 0.5,
  curious: 0.5,
  goofy: 0.5,
  surprised: 0.5,
  bashful: 0.4,
  gentle: 0.5,
  quirky: 0.5,
  dazed: 0.55,
};

/**
 * Slack the assertions allow, in icon px. The sampled bounds above sit within
 * 5e-5 path units of the curves' true extremes, so this is orders of magnitude
 * more room than the measurement needs and still far too tight for a framing
 * error to slip through.
 */
const PLACEMENT_TOLERANCE_PX = 0.01;

afterEach(() => {
  cleanup();
});

interface Placement {
  /** On-screen box of the eye artwork, in icon px. */
  box: BBox;
  centerX: number;
  centerY: number;
}

function expectWithinTolerance(actual: number, expected: number) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(
    PLACEMENT_TOLERANCE_PX,
  );
}

function sampledBounds(eyeStyleId: string): BBox {
  const bounds = SAMPLED_EYE_BOUNDS[eyeStyleId];
  if (!bounds) {
    throw new Error(`No sampled bounds for eye style "${eyeStyleId}"`);
  }
  return bounds;
}

function expectedSpanFraction(eyeStyleId: string): number {
  const fraction = EXPECTED_EYE_SPAN_FRACTION[eyeStyleId];
  if (fraction === undefined) {
    throw new Error(`No expected span for eye style "${eyeStyleId}"`);
  }
  return fraction;
}

/** Span a style's pair is expected to reach on a `size` icon, in px. */
function expectedSpan(eyeStyleId: string, size: number): number {
  return size * expectedSpanFraction(eyeStyleId);
}

/** Parse the `matrix(a,b,c,d,e,f)` the eye group is placed with. */
function readMatrix(group: Element): { scale: number; tx: number; ty: number } {
  const transform = group.getAttribute("transform") ?? "";
  const match = transform.match(
    /^matrix\((-?[\d.]+),0,0,(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\)$/,
  );
  if (!match) {
    throw new Error(`Unexpected eye transform: ${transform}`);
  }
  const scaleX = Number(match[1]);
  const scaleY = Number(match[2]);
  expect(scaleY).toBeCloseTo(scaleX, 6);
  return { scale: scaleX, tx: Number(match[3]), ty: Number(match[4]) };
}

/**
 * Where a box in path units lands on the icon, under the transform the
 * component rendered. `bounds` is the caller's yardstick, normally the sampled
 * ground truth for the style on screen.
 */
function placement(container: HTMLElement, bounds: BBox): Placement {
  const group = container.querySelector(
    '[data-testid="app-icon-preview-eyes"]',
  );
  if (!group) {
    throw new Error("No eye group rendered");
  }
  const { scale, tx, ty } = readMatrix(group);
  const box: BBox = {
    x: bounds.x * scale + tx,
    y: bounds.y * scale + ty,
    w: bounds.w * scale,
    h: bounds.h * scale,
  };
  return { box, centerX: box.x + box.w / 2, centerY: box.y + box.h / 2 };
}

/** The box the rendered paths' control polygon reaches, for contrast. */
function controlPolygonBounds(container: HTMLElement): BBox {
  const group = container.querySelector(
    '[data-testid="app-icon-preview-eyes"]',
  );
  if (!group) {
    throw new Error("No eye group rendered");
  }
  const paths = Array.from(group.querySelectorAll("path"));
  expect(paths.length).toBeGreaterThan(0);
  return unionBBox(paths.map((path) => pathBBox(path.getAttribute("d") ?? "")));
}

function field(container: HTMLElement): Element {
  const rect = container.querySelector(
    '[data-testid="app-icon-preview-field"]',
  );
  if (!rect) {
    throw new Error("No field rendered");
  }
  return rect;
}

describe("AppIconPreview", () => {
  test("centers a wide eye pair and fits it to half the icon", () => {
    // The wide pair takes the default span, so the assertions below can name
    // half the icon outright.
    expect(expectedSpanFraction(WIDE_EYE_STYLE)).toBe(
      DEFAULT_EYE_SPAN_FRACTION,
    );
    const span = SIZE * DEFAULT_EYE_SPAN_FRACTION;
    const { container } = render(
      <AppIconPreview
        components={BUNDLED_COMPONENTS}
        eyeStyle={WIDE_EYE_STYLE}
        color="green"
        size={SIZE}
      />,
    );

    const { box, centerX, centerY } = placement(
      container,
      sampledBounds(WIDE_EYE_STYLE),
    );
    expectWithinTolerance(centerX, SIZE / 2);
    expectWithinTolerance(centerY, SIZE / 2);
    // A pair wider than it is tall is fitted by its width.
    expectWithinTolerance(box.w, span);
    expect(box.h).toBeLessThanOrEqual(span + PLACEMENT_TOLERANCE_PX);
  });

  test("spans half the icon by default, dazed wider and bashful narrower", () => {
    expect(EXPECTED_EYE_SPAN_FRACTION.dazed).toBe(0.55);
    expect(EXPECTED_EYE_SPAN_FRACTION.bashful).toBe(0.4);
    for (const [eyeStyleId, fraction] of Object.entries(
      EXPECTED_EYE_SPAN_FRACTION,
    )) {
      if (eyeStyleId === "dazed" || eyeStyleId === "bashful") {
        continue;
      }
      expect(fraction).toBe(DEFAULT_EYE_SPAN_FRACTION);
    }
    expect(Object.keys(EXPECTED_EYE_SPAN_FRACTION).sort()).toEqual(
      BUNDLED_COMPONENTS.eyeStyles.map((eyeStyle) => eyeStyle.id).sort(),
    );
  });

  test("draws bashful narrower than surprised", () => {
    // The two styles are the same shape, so framing both at the default span
    // would draw two icons a user cannot tell apart.
    const spanOf = (eyeStyleId: string) => {
      const { container } = render(
        <AppIconPreview
          components={BUNDLED_COMPONENTS}
          eyeStyle={eyeStyleId}
          color="green"
          size={SIZE}
        />,
      );
      const { box } = placement(container, sampledBounds(eyeStyleId));
      cleanup();
      return Math.max(box.w, box.h);
    };

    expect(spanOf(NARROW_EYE_STYLE)).toBeLessThan(spanOf("surprised") * 0.9);
  });

  test("frames a primary preview on the default span whatever pair it draws", () => {
    for (const eyeStyleId of [PRIMARY_EYE_STYLE, NARROW_EYE_STYLE]) {
      const { container } = render(
        <AppIconPreview
          components={BUNDLED_COMPONENTS}
          eyeStyle={eyeStyleId}
          color="green"
          size={SIZE}
          primary
        />,
      );

      const { box, centerX, centerY } = placement(
        container,
        sampledBounds(eyeStyleId),
      );
      expectWithinTolerance(centerX, SIZE / 2);
      expectWithinTolerance(centerY, SIZE / 2);
      expectWithinTolerance(
        Math.max(box.w, box.h),
        SIZE * DEFAULT_EYE_SPAN_FRACTION,
      );
      cleanup();
    }
    // The narrow style's own entry sits under the default, so the loop above
    // is this prop at work rather than a span both framings would satisfy.
    expect(expectedSpanFraction(NARROW_EYE_STYLE)).toBeLessThan(
      DEFAULT_EYE_SPAN_FRACTION,
    );
  });

  test("fits a rounder pair by whichever axis is longer", () => {
    const { container } = render(
      <AppIconPreview
        components={BUNDLED_COMPONENTS}
        eyeStyle={ROUND_EYE_STYLE}
        color="green"
        size={SIZE}
      />,
    );

    const { box, centerX, centerY } = placement(
      container,
      sampledBounds(ROUND_EYE_STYLE),
    );
    expectWithinTolerance(centerX, SIZE / 2);
    expectWithinTolerance(centerY, SIZE / 2);
    expectWithinTolerance(
      Math.max(box.w, box.h),
      expectedSpan(ROUND_EYE_STYLE, SIZE),
    );
  });

  test("scales the framing with the requested size", () => {
    const { container } = render(
      <AppIconPreview
        components={BUNDLED_COMPONENTS}
        eyeStyle={WIDE_EYE_STYLE}
        color="green"
        size={32}
      />,
    );

    const { box, centerX, centerY } = placement(
      container,
      sampledBounds(WIDE_EYE_STYLE),
    );
    expectWithinTolerance(centerX, 16);
    expectWithinTolerance(centerY, 16);
    expectWithinTolerance(box.w, expectedSpan(WIDE_EYE_STYLE, 32));
  });

  test("paints the field in the trait color, with an app icon's corners", () => {
    const { container } = render(
      <AppIconPreview
        components={BUNDLED_COMPONENTS}
        eyeStyle={WIDE_EYE_STYLE}
        color="green"
        size={SIZE}
      />,
    );

    const rect = field(container);
    expect(rect.getAttribute("fill")).toBe(GREEN_HEX);
    expect(Number(rect.getAttribute("rx"))).toBeCloseTo(SIZE * 0.224, 6);
    expect(Number(rect.getAttribute("width"))).toBe(SIZE);
  });

  test("paints every catalog color as its own hex", () => {
    for (const color of BUNDLED_COMPONENTS.colors) {
      const { container } = render(
        <AppIconPreview
          components={BUNDLED_COMPONENTS}
          eyeStyle={WIDE_EYE_STYLE}
          color={color.id}
          size={SIZE}
        />,
      );
      expect(field(container).getAttribute("fill")).toBe(color.hex);
      cleanup();
    }
  });

  test("has ground truth for exactly the styles the catalog ships", () => {
    expect(Object.keys(SAMPLED_EYE_BOUNDS).sort()).toEqual(
      BUNDLED_COMPONENTS.eyeStyles.map((eyeStyle) => eyeStyle.id).sort(),
    );
    expect(BUNDLED_COMPONENTS.eyeStyles.length).toBe(9);
  });

  test("renders every bundled eye style inside the icon", () => {
    for (const eyeStyle of BUNDLED_COMPONENTS.eyeStyles) {
      const { container } = render(
        <AppIconPreview
          components={BUNDLED_COMPONENTS}
          eyeStyle={eyeStyle.id}
          color="teal"
          size={SIZE}
        />,
      );

      // The artwork on screen is this style's, so the geometry below is being
      // asserted about the paths the ground truth was measured from.
      const rendered = Array.from(
        container.querySelectorAll(
          '[data-testid="app-icon-preview-eyes"] path',
        ),
      );
      expect(rendered.map((path) => path.getAttribute("d"))).toEqual(
        eyeStyle.paths.map((path) => path.svgPath),
      );
      expect(rendered.map((path) => path.getAttribute("fill"))).toEqual(
        eyeStyle.paths.map((path) => path.color),
      );

      const { box, centerX, centerY } = placement(
        container,
        sampledBounds(eyeStyle.id),
      );
      expectWithinTolerance(centerX, SIZE / 2);
      expectWithinTolerance(centerY, SIZE / 2);
      expectWithinTolerance(
        Math.max(box.w, box.h),
        expectedSpan(eyeStyle.id, SIZE),
      );
      expect(box.x).toBeGreaterThanOrEqual(-PLACEMENT_TOLERANCE_PX);
      expect(box.y).toBeGreaterThanOrEqual(-PLACEMENT_TOLERANCE_PX);
      expect(box.x + box.w).toBeLessThanOrEqual(SIZE + PLACEMENT_TOLERANCE_PX);
      expect(box.y + box.h).toBeLessThanOrEqual(SIZE + PLACEMENT_TOLERANCE_PX);
      cleanup();
    }
  });

  test("frames the eyes on their ink, not on their control points", () => {
    // `angry` is drawn with control points far below the curve, so its
    // control-point box is 72% taller than the artwork. The generated PNG
    // centers what the rasterizer sees, and so must this.
    const { container } = render(
      <AppIconPreview
        components={BUNDLED_COMPONENTS}
        eyeStyle="angry"
        color="green"
        size={SIZE}
      />,
    );

    const drawn = placement(container, sampledBounds("angry"));
    expectWithinTolerance(drawn.centerX, SIZE / 2);
    expectWithinTolerance(drawn.centerY, SIZE / 2);

    // The two boxes really do disagree here, so the assertion above is a
    // choice between them rather than a tautology.
    const controlPolygon = placement(
      container,
      controlPolygonBounds(container),
    );
    expect(Math.abs(controlPolygon.centerY - SIZE / 2)).toBeGreaterThan(1);
  });

  test("renders the field alone for an unknown eye style", () => {
    const { container } = render(
      <AppIconPreview
        components={BUNDLED_COMPONENTS}
        eyeStyle="not-an-eye-style"
        color="green"
        size={SIZE}
      />,
    );

    expect(
      container.querySelector('[data-testid="app-icon-preview-eyes"]'),
    ).toBeNull();
    expect(field(container).getAttribute("fill")).toBe(GREEN_HEX);
  });

  test("falls back to a neutral field for an unknown color", () => {
    const { container } = render(
      <AppIconPreview
        components={BUNDLED_COMPONENTS}
        eyeStyle={WIDE_EYE_STYLE}
        color="not-a-color"
        size={SIZE}
      />,
    );

    expect(field(container).getAttribute("fill")).toBe("var(--surface-sunken)");
    // The eyes still draw: one unknown id does not take the other down.
    expectWithinTolerance(
      placement(container, sampledBounds(WIDE_EYE_STYLE)).box.w,
      expectedSpan(WIDE_EYE_STYLE, SIZE),
    );
  });

  test("renders the field alone before the catalog loads", () => {
    const { container } = render(
      <AppIconPreview
        components={null}
        eyeStyle={WIDE_EYE_STYLE}
        color="green"
        size={SIZE}
      />,
    );

    expect(
      container.querySelector('[data-testid="app-icon-preview-eyes"]'),
    ).toBeNull();
    expect(field(container).getAttribute("fill")).toBe("var(--surface-sunken)");
  });

  test("renders the field alone for an eye style with no paths", () => {
    const emptyArt: CharacterComponents = {
      ...BUNDLED_COMPONENTS,
      eyeStyles: [
        {
          id: "blank",
          sourceViewBox: { width: 100, height: 100 },
          eyeCenter: { x: 50, y: 50 },
          paths: [],
        },
      ],
    };
    const { container } = render(
      <AppIconPreview
        components={emptyArt}
        eyeStyle="blank"
        color="green"
        size={SIZE}
      />,
    );

    expect(
      container.querySelector('[data-testid="app-icon-preview-eyes"]'),
    ).toBeNull();
    expect(field(container).getAttribute("fill")).toBe(GREEN_HEX);
  });
});
