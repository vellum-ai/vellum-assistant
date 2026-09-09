/**
 * `ChatInfoSection` decides how many tiles a row shows from one number: the
 * row's measured width. The suite drives that width and the window-size axis
 * through module mocks rather than a layout engine, since happy-dom reports a
 * zero box for everything.
 *
 * Tiles are plain elements here. The section is generic over its item type and
 * never inspects a tile, so the real Chat Info tiles would only add mocks.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { DETAIL_SHELL_BODY_INSET_PX } from "@/components/detail-shell";
import { CHAT_INFO_APP_TILE_WIDTH_PX } from "@/domains/chat/components/chat-info-app-tile";
import { CHAT_INFO_FILE_TILE_WIDTH_PX } from "@/domains/chat/components/chat-info-file-tile";
import {
  CHAT_INFO_DRAWER_WIDTH_PX,
  CHAT_INFO_NARROW_PHONE_PX,
  makeElementSizeMock,
  makeIsMobileMock,
} from "@/domains/chat/components/chat-info.test-helper";

const widthRef = { value: CHAT_INFO_DRAWER_WIDTH_PX };
const isMobileRef = { value: false };

mock.module("@/hooks/use-element-size", () =>
  makeElementSizeMock(() => widthRef.value),
);

mock.module("@/hooks/use-is-mobile", () =>
  makeIsMobileMock(() => isMobileRef.value),
);

const { ChatInfoSection, fitTileCount } =
  await import("@/domains/chat/components/chat-info-section");

/** What the narrowest phone leaves once the body takes its inset off both edges. */
const NARROW_COLUMN_WIDTH =
  CHAT_INFO_NARROW_PHONE_PX - DETAIL_SHELL_BODY_INSET_PX * 2;

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
      renderTile={(item, layout) => (
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
  widthRef.value = CHAT_INFO_DRAWER_WIDTH_PX;
  isMobileRef.value = false;
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  mock.restore();
});

describe("fitTileCount", () => {
  test.each([
    [CHAT_INFO_DRAWER_WIDTH_PX, CHAT_INFO_APP_TILE_WIDTH_PX, 3],
    [CHAT_INFO_DRAWER_WIDTH_PX, CHAT_INFO_FILE_TILE_WIDTH_PX, 4],
    [378, CHAT_INFO_APP_TILE_WIDTH_PX, 2],
    [378, CHAT_INFO_FILE_TILE_WIDTH_PX, 2],
    [0, CHAT_INFO_FILE_TILE_WIDTH_PX, 1],
    [100, CHAT_INFO_FILE_TILE_WIDTH_PX, 1],
  ])("fits %p / %p tiles on one line", (rowWidth, tileWidth, expected) => {
    expect(fitTileCount(rowWidth, tileWidth)).toBe(expected);
  });
});

describe("ChatInfoSection", () => {
  test("truncates a roomy row to the tiles that fit and offers See All", () => {
    renderSection({
      items: makeItems(5),
      tileWidth: CHAT_INFO_APP_TILE_WIDTH_PX,
    });

    expect(tiles()).toHaveLength(3);
    expect(tiles()[0]?.getAttribute("data-layout")).toBe("fitted");
    expect(seeAll()).not.toBeNull();
  });

  test("shows every tile and no See All when the category fits", () => {
    renderSection({
      items: makeItems(4),
      tileWidth: CHAT_INFO_FILE_TILE_WIDTH_PX,
    });

    expect(tiles()).toHaveLength(4);
    expect(seeAll()).toBeNull();
  });

  test("offers See All from the category total, not the loaded page", () => {
    renderSection({
      items: makeItems(4),
      count: 12,
      tileWidth: CHAT_INFO_FILE_TILE_WIDTH_PX,
    });

    expect(tiles()).toHaveLength(4);
    expect(seeAll()).not.toBeNull();
  });

  test("scrolls the whole fetched set on a narrow window", () => {
    isMobileRef.value = true;
    const { container } = renderSection({
      items: makeItems(5),
      tileWidth: CHAT_INFO_APP_TILE_WIDTH_PX,
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
    // The strip shows the column plus the inset it reclaims on the right.
    isMobileRef.value = true;
    widthRef.value = NARROW_COLUMN_WIDTH;

    const fitted = renderSection({
      items: makeItems(2),
      count: 2,
      tileWidth: CHAT_INFO_APP_TILE_WIDTH_PX,
    });
    expect(seeAll()).toBeNull();
    fitted.unmount();

    renderSection({
      items: makeItems(3),
      count: 3,
      tileWidth: CHAT_INFO_APP_TILE_WIDTH_PX,
    });
    expect(seeAll()).not.toBeNull();
  });

  test("pays the reclaimed inset back on both edges of the strip", () => {
    // A strip that fits is then exactly as wide as its scroller, and one that
    // runs past the column stops with the inset showing past its last tile.
    isMobileRef.value = true;
    widthRef.value = NARROW_COLUMN_WIDTH;

    for (const itemCount of [2, 8]) {
      const { container, unmount } = renderSection({
        items: makeItems(itemCount),
        count: itemCount,
        tileWidth: CHAT_INFO_APP_TILE_WIDTH_PX,
      });
      const strip = container.querySelector(
        '[data-slot="scroll-shadow"][data-orientation="horizontal"]',
      );
      expect(strip?.className).toContain("px-[var(--chat-info-strip-bleed)]");
      unmount();
    }
  });

  test("names the section by its title", () => {
    const { container } = renderSection({
      items: makeItems(2),
      tileWidth: CHAT_INFO_FILE_TILE_WIDTH_PX,
    });

    const labelledBy = container
      .querySelector("section")
      ?.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)?.textContent).toBe("Apps");
  });

  test("calls onSeeAll when the control is activated", () => {
    let seeAllCalls = 0;
    renderSection({
      items: makeItems(5),
      tileWidth: CHAT_INFO_APP_TILE_WIDTH_PX,
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
      tileWidth: CHAT_INFO_FILE_TILE_WIDTH_PX,
    });

    expect(screen.getByText("Apps")).not.toBeNull();
    expect(screen.getByText("12")).not.toBeNull();
    expect(seeAll()?.textContent).toBe("See All");
  });
});
