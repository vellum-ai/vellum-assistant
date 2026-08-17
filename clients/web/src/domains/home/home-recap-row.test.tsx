/**
 * Tests for `HomeRecapRow`.
 *
 * Rendered into happy-dom via `@testing-library/react` so clicks can be
 * dispatched. Assertions target text, roles, `aria-label`s, test ids, and DOM
 * structure, never class strings: those drift with styling and turn behaviour
 * tests into styling tests.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

import {
  viewportAxesStub,
  type ViewportAxes,
} from "@/hooks/viewport-axes.test-helper";
import type { FeedItem, FeedItemStatus } from "@vellumai/assistant-api";

import { HomeRecapRow, type HomeRecapRowProps } from "./home-recap-row";
import { feedItem } from "./feed-test-fixtures";

/** A mouse: the row's inline controls are the path to its commands. */
const MOUSE: ViewportAxes = { narrow: false, coarsePointer: false };
/** A phone: no hover to reveal anything, so the commands move behind a button. */
const TOUCH: ViewportAxes = { narrow: true, coarsePointer: true };

const viewport = viewportAxesStub();

/** The long-press threshold in `use-long-press`, plus room for the timer. */
const LONG_PRESS_MS = 600;

async function longPressCard() {
  const card = screen.getByRole("button", { name: "Watcher job failed" });

  fireEvent.touchStart(card, { touches: [{ clientX: 10, clientY: 10 }] });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, LONG_PRESS_MS));
  });
  fireEvent.touchEnd(card);
}

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

function makeItem(overrides: Partial<FeedItem> = {}): FeedItem {
  // Relative so the row's date formatting renders a real "3d ago".
  const timestamp = new Date(Date.now() - THREE_DAYS_MS).toISOString();
  return feedItem({
    id: "feed-1",
    category: "background",
    title: "Watcher job failed",
    summary: "The watcher job could not reach the upstream service.",
    timestamp,
    createdAt: timestamp,
    conversationId: "conversation-1",
    ...overrides,
  });
}

function renderRow(props: Partial<HomeRecapRowProps> = {}) {
  const selected: FeedItem[] = [];
  const dismissed: string[] = [];
  const readToggles: Array<[string, FeedItemStatus]> = [];
  const threads: string[] = [];
  const item = props.item ?? makeItem();

  const { container } = render(
    <HomeRecapRow
      item={item}
      onSelect={(selectedItem) => selected.push(selectedItem)}
      onDismiss={(itemId) => dismissed.push(itemId)}
      onToggleRead={(itemId, status) => readToggles.push([itemId, status])}
      onGoToThread={(conversationId) => threads.push(conversationId)}
      {...props}
    />,
  );

  return { container, item, selected, dismissed, readToggles, threads };
}

beforeEach(() => {
  viewport.set(MOUSE);
});

afterEach(() => {
  cleanup();
  viewport.restore();
});

describe("HomeRecapRow", () => {
  test("renders no button inside another button", () => {
    renderRow();

    expect(document.querySelectorAll("button button").length).toBe(0);
  });

  test("exposes one click target named after the title", () => {
    const { item, selected } = renderRow();

    fireEvent.click(screen.getByRole("button", { name: "Watcher job failed" }));

    expect(selected).toEqual([item]);
  });

  test("falls back to the summary for the click target's name", () => {
    renderRow({ item: makeItem({ title: undefined }) });

    expect(
      screen.getByRole("button", {
        name: "The watcher job could not reach the upstream service.",
      }),
    ).toBeTruthy();
  });

  test("renders the actions without any hover simulation", () => {
    renderRow();

    expect(screen.getByRole("button", { name: "Mark as read" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Go to thread" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
  });

  test("renders the timestamp alongside the actions", () => {
    renderRow();

    expect(screen.getByText("3d ago")).toBeTruthy();
  });

  test("the timestamp yields the cell the inline actions share with it", () => {
    renderRow();

    expect(screen.getByText("3d ago").getAttribute("data-reveal-yield")).toBe(
      "",
    );
  });

  test("labels the read toggle for an already-read item", () => {
    renderRow({ item: makeItem({ status: "seen" }) });

    expect(screen.getByRole("button", { name: "Mark as unread" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Mark as read" })).toBeNull();
  });

  test("dismiss fires its callback without selecting the row", () => {
    const { selected, dismissed } = renderRow();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(dismissed).toEqual(["feed-1"]);
    expect(selected).toEqual([]);
  });

  test("mark as read fires its callback without selecting the row", () => {
    const { selected, readToggles } = renderRow();

    fireEvent.click(screen.getByRole("button", { name: "Mark as read" }));

    expect(readToggles).toEqual([["feed-1", "seen"]]);
    expect(selected).toEqual([]);
  });

  test("go to thread marks an unread item read and navigates", () => {
    const { selected, readToggles, threads } = renderRow();

    fireEvent.click(screen.getByRole("button", { name: "Go to thread" }));

    expect(readToggles).toEqual([["feed-1", "seen"]]);
    expect(threads).toEqual(["conversation-1"]);
    expect(selected).toEqual([]);
  });

  test("hides go to thread when the conversation is not listed as valid", () => {
    renderRow({ validConversationIds: new Set(["other-conversation"]) });

    expect(screen.queryByRole("button", { name: "Go to thread" })).toBeNull();
  });

  test("hides go to thread when the item has no conversation", () => {
    renderRow({ item: makeItem({ conversationId: undefined }) });

    expect(screen.queryByRole("button", { name: "Go to thread" })).toBeNull();
  });

  test("omits the read toggle when no handler is supplied", () => {
    render(
      <HomeRecapRow
        item={makeItem()}
        onSelect={() => {}}
        onDismiss={() => {}}
      />,
    );

    expect(screen.queryByRole("button", { name: "Mark as read" })).toBeNull();
  });

  test("the restore variant renders only the restore control", () => {
    const { dismissed } = renderRow({ trailingAction: "restore" });

    expect(screen.queryByRole("button", { name: "Mark as read" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Go to thread" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Restore" }));

    expect(dismissed).toEqual(["feed-1"]);
  });
});

describe("HomeRecapRow on a device that cannot hover", () => {
  beforeEach(() => {
    viewport.set(TOUCH);
  });

  test("keeps the timestamp and drops the inline controls", () => {
    renderRow();

    expect(screen.getByText("3d ago")).toBeTruthy();
    // Absent, not merely unpainted: the two share one cell, so a control left
    // in it is what would push the timestamp out.
    expect(screen.getByText("3d ago").getAttribute("data-reveal-yield")).toBe(
      null,
    );
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark as read" })).toBeNull();
  });

  /* The gestures are accelerators, so the row still needs one control that can
     be found by name and reached by a keyboard, a screen reader, or switch
     control. */
  test("names a visible control that opens every command as a sheet", async () => {
    const { dismissed } = renderRow();

    const trigger = screen.getByRole("button", { name: "Update Actions" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);

    const sheet = screen.getByRole("dialog");
    for (const label of ["Mark as read", "Go to thread", "Dismiss"]) {
      expect(sheet.textContent?.includes(label)).toBe(true);
    }

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(dismissed).toEqual(["feed-1"]);
  });

  /* The control is the sheet's own trigger rather than a button that sets the
     sheet's state, which is what has the dialog announce its state on the
     control and hand focus back to it on close. Asserted through the wiring the
     dialog owns, because focus restoration itself is a browser behaviour this
     environment does not model. */
  test("the control is the sheet's trigger, not a button beside it", () => {
    renderRow();
    const trigger = screen.getByRole("button", { name: "Update Actions" });

    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-controls")).toBe(
      screen.getByRole("dialog").id,
    );
  });

  test("opening the commands does not also open the item", () => {
    const { selected } = renderRow();

    fireEvent.click(screen.getByRole("button", { name: "Update Actions" }));

    expect(selected).toEqual([]);
  });

  test("a swipe reaches the commands that change the item's state", () => {
    const { container, dismissed, readToggles } = renderRow();
    const swipeControl = (label: string) =>
      container.querySelector<HTMLButtonElement>(
        `button[aria-label="${label}"]`,
      );

    // Behind the row until a swipe slides it away, hence `aria-hidden` and out
    // of the tab path rather than exposed by role.
    expect(swipeControl("Mark as read")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    expect(swipeControl("Dismiss")?.getAttribute("aria-hidden")).toBe("true");
    expect(swipeControl("Go to thread")).toBeNull();

    fireEvent.click(swipeControl("Mark as read")!);
    fireEvent.click(swipeControl("Dismiss")!);

    expect(readToggles).toEqual([["feed-1", "seen"]]);
    expect(dismissed).toEqual(["feed-1"]);
  });

  test("a long press opens a sheet listing every command", async () => {
    renderRow();

    await longPressCard();

    expect(screen.getByRole("dialog")).toBeTruthy();
    for (const label of ["Mark as read", "Go to thread", "Dismiss"]) {
      expect(screen.getByRole("dialog").textContent?.includes(label)).toBe(
        true,
      );
    }
  });

  /* The release emits a click the sheet's dismissable layer would read as a
     click outside itself, closing the sheet the press just opened. */
  test("the sheet a long press opened survives the release", async () => {
    renderRow();

    await longPressCard();
    fireEvent.click(document.body);

    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  test("the compatibility click after a long press does not open the item", async () => {
    const { selected } = renderRow();
    // Held before the press: the sheet is modal, so it marks the content behind
    // it `aria-hidden` and a role query would no longer find the card.
    const card = screen.getByRole("button", { name: "Watcher job failed" });

    await longPressCard();
    fireEvent.click(card);

    expect(selected).toEqual([]);
  });

  test("a plain tap still opens the item", () => {
    const { item, selected } = renderRow();
    const card = screen.getByRole("button", { name: "Watcher job failed" });

    fireEvent.touchStart(card, { touches: [{ clientX: 10, clientY: 10 }] });
    fireEvent.touchEnd(card);
    fireEvent.click(card);

    expect(selected).toEqual([item]);
  });

  test("the restore variant keeps its one command reachable by swipe", () => {
    const { container, dismissed } = renderRow({ trailingAction: "restore" });
    const restore = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Restore"]',
    );

    expect(restore).not.toBeNull();

    fireEvent.click(restore!);

    expect(dismissed).toEqual(["feed-1"]);
  });
});

describe("HomeRecapRow card content", () => {
  test("renders the category, the title, and a preview of the summary", () => {
    renderRow();

    expect(screen.getByText("Background")).toBeTruthy();
    expect(screen.getByText("Watcher job failed")).toBeTruthy();
    expect(
      screen.getByText("The watcher job could not reach the upstream service."),
    ).toBeTruthy();
  });

  test("renders no preview when the summary only restates the title", () => {
    renderRow({
      item: makeItem({
        title: "Watcher job failed",
        summary: "Watcher job failed",
      }),
    });

    expect(screen.getAllByText("Watcher job failed").length).toBe(1);
  });

  test("an untitled item shows its summary once and no preview", () => {
    const summary = "The watcher job could not reach the upstream service.";
    renderRow({ item: makeItem({ title: undefined }) });

    expect(screen.getAllByText(summary).length).toBe(1);
  });

  test("an untitled item renders its markdown summary as plain text once", () => {
    const { container } = renderRow({
      item: makeItem({
        title: undefined,
        summary: "## Deploy failed\n\n**The api** never came up.",
      }),
    });
    const flattened = "Deploy failed The api never came up.";

    expect(screen.getAllByText(flattened).length).toBe(1);
    expect(screen.getByRole("button", { name: flattened })).toBeTruthy();
    expect(container.textContent).not.toContain("*");
    expect(container.textContent).not.toContain("#");
  });

  test("an untitled item with no renderable summary still names its click target", () => {
    renderRow({
      item: makeItem({ title: undefined, summary: "```\nconst a = 1;\n```" }),
    });

    expect(screen.getByRole("button", { name: "Notification" })).toBeTruthy();
  });

  test("renders an informative source label", () => {
    renderRow({ item: makeItem({ sourceLabel: "Heartbeat" }) });

    expect(screen.getByText("Heartbeat")).toBeTruthy();
  });

  test.each(["Conversation", "Other"])(
    "omits the generic %s source label",
    (sourceLabel) => {
      renderRow({ item: makeItem({ sourceLabel }) });

      expect(screen.queryByText(sourceLabel)).toBeNull();
    },
  );

  test("marks an unread item with a dot inside the gutter", () => {
    renderRow();

    const dot = screen.getByTestId("home-recap-row-unread-dot");

    expect(dot.parentElement).toBe(
      screen.getByTestId("home-recap-row-dot-gutter"),
    );
  });

  test.each(["comfortable", "compact"] as const)(
    "%s density keeps the dot's gutter for an already-read item",
    (density) => {
      renderRow({ density, item: makeItem({ status: "seen" }) });

      expect(screen.getByTestId("home-recap-row-dot-gutter")).toBeTruthy();
      expect(screen.queryByTestId("home-recap-row-unread-dot")).toBeNull();
    },
  );

  test("the gutter leads the card, with the content stack beside it", () => {
    renderRow();
    const gutter = screen.getByTestId("home-recap-row-dot-gutter");
    const title = screen.getByTestId("home-recap-row-title");

    expect(gutter.nextElementSibling?.contains(title)).toBe(true);
  });
});

describe("HomeRecapRow density", () => {
  test("comfortable keeps the category chip and the source label", () => {
    renderRow({ item: makeItem({ sourceLabel: "Heartbeat" }) });

    expect(screen.getByText("Background")).toBeTruthy();
    expect(screen.getByText("Heartbeat")).toBeTruthy();
  });

  test("compact drops the category chip and the source label", () => {
    renderRow({
      density: "compact",
      item: makeItem({ sourceLabel: "Heartbeat" }),
    });

    expect(screen.queryByText("Background")).toBeNull();
    expect(screen.queryByText("Heartbeat")).toBeNull();
  });

  test("compact keeps the title, the timestamp, and the preview", () => {
    renderRow({ density: "compact" });

    expect(screen.getByText("Watcher job failed")).toBeTruthy();
    expect(screen.getByText("3d ago")).toBeTruthy();
    expect(
      screen.getByText("The watcher job could not reach the upstream service."),
    ).toBeTruthy();
  });

  // happy-dom does no layout, so this asserts the structure the card's
  // no-overlap behaviour rests on: one line carrying both the title and the
  // timestamp, with the title in its own element so it can shrink.
  test("a long compact title shares its line with the timestamp", () => {
    const longTitle = "Averylongunbreakablenotificationtitle".repeat(4);
    renderRow({ density: "compact", item: makeItem({ title: longTitle }) });

    const title = screen.getByTestId("home-recap-row-title");
    const timestampLine =
      screen.getByText("3d ago").parentElement?.parentElement;

    expect(title.textContent).toBe(longTitle);
    expect(timestampLine?.contains(title)).toBe(true);
  });

  test("comfortable puts the title under the meta row, not on it", () => {
    renderRow();

    const title = screen.getByTestId("home-recap-row-title");
    const timestampLine =
      screen.getByText("3d ago").parentElement?.parentElement;

    expect(timestampLine?.contains(title)).toBe(false);
  });
});
