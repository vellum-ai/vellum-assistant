import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";

const CARD_SURFACE_MODULE = "@/domains/chat/components/surfaces/card-surface";

/**
 * Whether the stubbed card surface throws on render.
 *
 * `mock.module` patches a module registry that a bun run shares across every
 * test file, and there is no way to undo it: re-registering the real module
 * afterwards does not restore it. So the stub stays installed for the rest of
 * the run and has to be transparent by default, delegating to the real
 * component. Only the boundary tests below flip this on. An unconditional
 * `throw` here fails every card-surface test that runs after this file.
 */
let cardSurfaceThrows = false;

// The component value, read out of the namespace before the mock replaces it.
// Holding the namespace object instead would recurse: `mock.module` patches
// that same object, so the stub would resolve `CardSurface` to itself.
const { CardSurface: RealCardSurface } = await import(CARD_SURFACE_MODULE);

// Replace one surface renderer with a component that throws on demand so we
// can assert the boundary contains the failure. Declared before importing
// `SurfaceRouter` so the mock is in place when the router resolves its imports.
mock.module(CARD_SURFACE_MODULE, () => ({
  CardSurface: (props: Record<string, unknown>) => {
    if (cardSurfaceThrows) {
      throw new Error("boom");
    }
    return <RealCardSurface {...props} />;
  },
}));

import { SurfaceRouter } from "@/domains/chat/components/surfaces/surface-router";
import type { Surface } from "@/domains/chat/types/types";

afterEach(() => {
  cleanup();
});

afterAll(() => {
  cardSurfaceThrows = false;
});

function makeSurface(overrides: Partial<Surface> = {}): Surface {
  return {
    surfaceId: "surface-1",
    surfaceType: "card",
    title: "My App",
    display: "inline",
    data: {},
    ...overrides,
  } as Surface;
}

describe("SurfaceRouter error boundary", () => {
  beforeEach(() => {
    cardSurfaceThrows = true;
  });

  afterEach(() => {
    cardSurfaceThrows = false;
  });

  test("contains a surface render failure behind an inline fallback", () => {
    const { getByRole } = render(
      <SurfaceRouter surface={makeSurface()} onAction={() => {}} />,
    );

    const alert = getByRole("alert");
    expect(alert.textContent).toContain("My App");
    expect(alert.textContent).toContain("couldn't be displayed");
  });

  test("a crashing surface does not take down a sibling surface", () => {
    const { getByRole, getByText } = render(
      <>
        <SurfaceRouter surface={makeSurface()} onAction={() => {}} />
        <SurfaceRouter
          surface={makeSurface({
            surfaceId: "surface-2",
            surfaceType: "copy_block",
            data: { text: "still here" },
          })}
          onAction={() => {}}
        />
      </>,
    );

    // The card surface is contained…
    expect(getByRole("alert").textContent).toContain("My App");
    // …while the sibling copy_block surface renders normally.
    expect(getByText("still here")).toBeTruthy();
  });
});

describe("SurfaceRouter — visual surfaces", () => {
  test("routes surfaceType \"visual\" to the sandboxed widget iframe", () => {
    const { container } = render(
      // VisualSurface relays widget prompts through useNavigate.
      <MemoryRouter>
        <SurfaceRouter
          surface={makeSurface({
            surfaceId: "surface-visual",
            surfaceType: "visual",
            title: "Star schema",
            data: { html: "<div>widget</div>", height: 240 },
          })}
          onAction={() => {}}
        />
      </MemoryRouter>,
    );

    const iframe = container.querySelector("iframe");
    expect(iframe).toBeTruthy();
    expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe?.getAttribute("title")).toBe("Star schema");
    expect(iframe?.getAttribute("srcdoc")).toContain("<div>widget</div>");
    // Falls through to the generic unsupported-surface card only for unknown types.
    expect(container.textContent).not.toContain("Unsupported surface type");
  });

  test("renders nothing rather than crashing when a visual carries no HTML", () => {
    const { container } = render(
      <MemoryRouter>
        <SurfaceRouter
          surface={makeSurface({
            surfaceId: "surface-visual-empty",
            surfaceType: "visual",
            data: {},
          })}
          onAction={() => {}}
        />
      </MemoryRouter>,
    );

    expect(container.querySelector("iframe")).toBeNull();
    // Not the error boundary — the surface degrades on its own.
    expect(container.querySelector("[role='alert']")).toBeNull();
  });
});
