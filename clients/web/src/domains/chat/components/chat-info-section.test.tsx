/**
 * `ChatInfoSection` decides how many tiles a row shows from one number: the
 * row's measured width. The suite drives that width and the window-size axis
 * through module mocks rather than a layout engine, since happy-dom reports a
 * zero box for everything.
 *
 * Tiles are plain elements here. The section is generic over its item type and
 * never inspects a tile, so the real Chat Info tiles would only add mocks.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type * as ElementSizeModule from "@/hooks/use-element-size";
import type * as IsMobileModule from "@/hooks/use-is-mobile";

const widthRef = { value: 569 };
const isMobileRef = { value: false };

mock.module(
  "@/hooks/use-element-size",
  (): Partial<typeof ElementSizeModule> => ({
    useElementSize: () => ({
      ref: () => {},
      size: { w: widthRef.value, h: 0 },
    }),
  }),
);

mock.module(
  "@/hooks/use-is-mobile",
  (): Partial<typeof IsMobileModule> => ({
    useIsMobile: () => isMobileRef.value,
    MOBILE_MEDIA_QUERY: "(max-width: 767px)",
  }),
);

const { ChatInfoSection, fitTileCount } =
  await import("@/domains/chat/components/chat-info-section");

/** The mock's tile widths: apps and files or camera frames. */
const APP_TILE_WIDTH = 184;
const FILE_TILE_WIDTH = 135;
/** The drawer's body width on the desktop mock. */
const DRAWER_WIDTH = 569;

const SEE_ALL_ARIA = "See all apps";
const TILE_TESTID = "section-tile";

interface Item {
  id: string;
}

function makeItems(count: number): Item[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `item-${index}`,
  }));
}

function renderSection({
  items,
  count,
  tileWidth,
  onSeeAll = () => {},
}: {
  items: Item[];
  count?: number;
  tileWidth: number;
  onSeeAll?: () => void;
}) {
  return render(
    <ChatInfoSection
      title="Apps"
      count={count ?? items.length}
      items={items}
      tileWidth={tileWidth}
      seeAllAriaLabel={SEE_ALL_ARIA}
      onSeeAll={onSeeAll}
      renderTile={(item, _index, layout) => (
        <div key={item.id} data-testid={TILE_TESTID} data-layout={layout}>
          {item.id}
        </div>
      )}
    />,
  );
}

function tiles(): HTMLElement[] {
  return screen.queryAllByTestId(TILE_TESTID);
}

function seeAll(): HTMLElement | null {
  return screen.queryByRole("button", { name: SEE_ALL_ARIA });
}

beforeEach(() => {
  widthRef.value = DRAWER_WIDTH;
  isMobileRef.value = false;
});

afterEach(() => {
  cleanup();
});

describe("fitTileCount", () => {
  test.each([
    [DRAWER_WIDTH, APP_TILE_WIDTH, 3],
    [DRAWER_WIDTH, FILE_TILE_WIDTH, 4],
    [378, APP_TILE_WIDTH, 2],
    [378, FILE_TILE_WIDTH, 2],
    [0, FILE_TILE_WIDTH, 1],
    [100, FILE_TILE_WIDTH, 1],
  ])("fits %p / %p tiles on one line", (rowWidth, tileWidth, expected) => {
    expect(fitTileCount(rowWidth, tileWidth)).toBe(expected);
  });

  test("a wider gutter fits fewer tiles on the same row", () => {
    expect(fitTileCount(DRAWER_WIDTH, APP_TILE_WIDTH, 40)).toBe(2);
  });
});

describe("ChatInfoSection", () => {
  test("truncates a roomy row to the tiles that fit and offers See All", () => {
    renderSection({ items: makeItems(5), tileWidth: APP_TILE_WIDTH });

    expect(tiles()).toHaveLength(3);
    expect(tiles()[0]?.getAttribute("data-layout")).toBe("fitted");
    expect(seeAll()).not.toBeNull();
  });

  test("shows every tile and no See All when the category fits", () => {
    renderSection({ items: makeItems(4), tileWidth: FILE_TILE_WIDTH });

    expect(tiles()).toHaveLength(4);
    expect(seeAll()).toBeNull();
  });

  test("offers See All from the category total, not the loaded page", () => {
    renderSection({
      items: makeItems(4),
      count: 12,
      tileWidth: FILE_TILE_WIDTH,
    });

    expect(tiles()).toHaveLength(4);
    expect(seeAll()).not.toBeNull();
  });

  test("scrolls the whole fetched set on a narrow window", () => {
    isMobileRef.value = true;
    const { container } = renderSection({
      items: makeItems(5),
      tileWidth: APP_TILE_WIDTH,
    });

    const strip = container.querySelector(
      '[data-slot="scroll-shadow"][data-orientation="horizontal"]',
    );
    expect(strip).not.toBeNull();
    expect(
      strip?.querySelectorAll(`[data-testid="${TILE_TESTID}"]`),
    ).toHaveLength(5);
    expect(tiles()[0]?.getAttribute("data-layout")).toBe("strip");
    expect(seeAll()).not.toBeNull();
  });

  test("counts the strip's reclaimed right inset toward the narrow-window fit", () => {
    // A 402px phone leaves a 362px column; the strip shows 382px of tiles.
    isMobileRef.value = true;
    widthRef.value = 362;

    const fitted = renderSection({
      items: makeItems(2),
      count: 2,
      tileWidth: APP_TILE_WIDTH,
    });
    expect(seeAll()).toBeNull();
    // Nothing runs past the edge, so the strip claims no trailing inset.
    expect(fitted.container.querySelector("[data-overflow]")).toBeNull();
    fitted.unmount();

    const overflowing = renderSection({
      items: makeItems(3),
      count: 3,
      tileWidth: APP_TILE_WIDTH,
    });
    expect(seeAll()).not.toBeNull();
    expect(
      overflowing.container.querySelector("[data-overflow]"),
    ).not.toBeNull();
  });

  test("calls onSeeAll when the control is activated", () => {
    let seeAllCalls = 0;
    renderSection({
      items: makeItems(5),
      tileWidth: APP_TILE_WIDTH,
      onSeeAll: () => {
        seeAllCalls += 1;
      },
    });

    fireEvent.click(seeAll()!);

    expect(seeAllCalls).toBe(1);
  });

  test("heads the row with the title, the count, and the catalog's See All copy", () => {
    renderSection({
      items: makeItems(4),
      count: 12,
      tileWidth: FILE_TILE_WIDTH,
    });

    expect(screen.getByText("Apps")).not.toBeNull();
    expect(screen.getByText("12")).not.toBeNull();
    expect(seeAll()?.textContent).toBe("See All");
  });
});
