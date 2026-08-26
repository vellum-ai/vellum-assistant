/**
 * Tests for `AppIconPreview`.
 *
 * The preview stands in for a 1024px PNG nobody can load in the web app, so
 * what is worth asserting is the composition it claims to reproduce: the eye
 * pair centered on the field and fitted to half of it, the field painted in
 * the trait color, every bundled eye style drawing something, and an id the
 * catalog does not carry degrading to the bare field instead of throwing.
 *
 * The geometry is read back off the DOM (the rendered `d` attributes through
 * the same bbox parser, under the rendered transform) rather than recomputed
 * from the fixture, so a component that framed the artwork some other way
 * cannot satisfy these assertions by agreeing with itself.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { AppIconPreview } from "@/components/avatar/app-icon-preview";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import {
  pathBBox,
  tightPathBBox,
  unionBBox,
  type BBox,
} from "@/utils/eye-bbox";
import type { CharacterComponents } from "@/types/avatar";

const SIZE = 128;
/** The eye pair spans half the icon, matching the bundled artwork. */
const SPAN = SIZE / 2;
const GREEN_HEX = "#4C9B50";

/** A wide pair and a rounder one, the two ends of what the framing must fit. */
const WIDE_EYE_STYLE = "grumpy";
const ROUND_EYE_STYLE = "gentle";

afterEach(() => {
  cleanup();
});

interface Placement {
  /** On-screen box of the eye artwork, in icon px. */
  box: BBox;
  centerX: number;
  centerY: number;
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
 * Where the rendered artwork actually lands on the icon. `measure` is the box
 * the caller wants the placement expressed in, so a test can ask which of the
 * two boxes the component framed against.
 */
function placement(
  container: HTMLElement,
  measure: (d: string) => BBox = tightPathBBox,
): Placement {
  const group = container.querySelector(
    '[data-testid="app-icon-preview-eyes"]',
  );
  if (!group) {
    throw new Error("No eye group rendered");
  }
  const paths = Array.from(group.querySelectorAll("path"));
  expect(paths.length).toBeGreaterThan(0);
  const bbox = unionBBox(
    paths.map((path) => measure(path.getAttribute("d") ?? "")),
  );
  const { scale, tx, ty } = readMatrix(group);
  const box: BBox = {
    x: bbox.x * scale + tx,
    y: bbox.y * scale + ty,
    w: bbox.w * scale,
    h: bbox.h * scale,
  };
  return { box, centerX: box.x + box.w / 2, centerY: box.y + box.h / 2 };
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
  test("centers the eye pair and fits it to half the icon", () => {
    const { container } = render(
      <AppIconPreview
        components={BUNDLED_COMPONENTS}
        eyeStyle={WIDE_EYE_STYLE}
        color="green"
        size={SIZE}
      />,
    );

    const { box, centerX, centerY } = placement(container);
    expect(centerX).toBeCloseTo(SIZE / 2, 6);
    expect(centerY).toBeCloseTo(SIZE / 2, 6);
    // A pair wider than it is tall is fitted by its width.
    expect(box.w).toBeCloseTo(SPAN, 6);
    expect(box.h).toBeLessThanOrEqual(SPAN + 1e-6);
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

    const { box, centerX, centerY } = placement(container);
    expect(centerX).toBeCloseTo(SIZE / 2, 6);
    expect(centerY).toBeCloseTo(SIZE / 2, 6);
    expect(Math.max(box.w, box.h)).toBeCloseTo(SPAN, 6);
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

    const { box, centerX, centerY } = placement(container);
    expect(centerX).toBeCloseTo(16, 6);
    expect(centerY).toBeCloseTo(16, 6);
    expect(box.w).toBeCloseTo(16, 6);
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

  test("renders every bundled eye style inside the icon", () => {
    expect(BUNDLED_COMPONENTS.eyeStyles.length).toBe(9);

    for (const eyeStyle of BUNDLED_COMPONENTS.eyeStyles) {
      const { container } = render(
        <AppIconPreview
          components={BUNDLED_COMPONENTS}
          eyeStyle={eyeStyle.id}
          color="teal"
          size={SIZE}
        />,
      );

      const { box, centerX, centerY } = placement(container);
      expect(centerX).toBeCloseTo(SIZE / 2, 6);
      expect(centerY).toBeCloseTo(SIZE / 2, 6);
      expect(Math.max(box.w, box.h)).toBeCloseTo(SPAN, 6);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.w).toBeLessThanOrEqual(SIZE);
      expect(box.y + box.h).toBeLessThanOrEqual(SIZE);
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

    const drawn = placement(container);
    expect(drawn.centerX).toBeCloseTo(SIZE / 2, 6);
    expect(drawn.centerY).toBeCloseTo(SIZE / 2, 6);

    // The two boxes really do disagree here, so the assertion above is a
    // choice between them rather than a tautology.
    const controlPolygon = placement(container, pathBBox);
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
    expect(placement(container).box.w).toBeCloseTo(SPAN, 6);
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
