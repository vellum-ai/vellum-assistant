/**
 * The All chats row's trailing cell: one slot holding the timestamp and the
 * Done check, with both ends flush right.
 *
 * jsdom lays nothing out, so this pins the structure the alignment rests on
 * rather than the pixels: the two occupants share a single `CrossfadeStack`
 * (so the check cannot shift the title when it appears), the badge yields to
 * the affordance rather than sitting beside it, and the row carries the
 * right-alignment override for both occupants. The centred default is what
 * put the check 32 to 58px inboard of the timestamp it replaces, drifting
 * with each row's text width.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { PanelItem } from "@vellumai/design-library/components/panel-item";

import {
  META_SLOT_CLASSES,
  ROW_META_CLASSES,
} from "@/domains/chat/pages/all-chats-page";

afterEach(cleanup);

function renderRow() {
  const { container } = render(
    <PanelItem
      label="Weekly meal plan"
      badge={<span className={ROW_META_CLASSES}>9:14 AM</span>}
      badgeBare
      trailingAction={
        <button type="button" aria-label="Mark as done">
          x
        </button>
      }
      onSelect={() => {}}
      className={`min-h-[36px] px-2 ${META_SLOT_CLASSES}`}
    />,
  );
  return container;
}

describe("the All chats row's trailing cell", () => {
  test("stacks the timestamp and the check in one shared slot", () => {
    const slots = renderRow().querySelectorAll('[data-slot="crossfade-stack"]');
    expect(slots).toHaveLength(1);
    expect(slots[0].children).toHaveLength(2);
  });

  test("makes the timestamp yield to the check rather than sit beside it", () => {
    const slot = renderRow().querySelector('[data-slot="crossfade-stack"]')!;
    const [badge, trailing] = [...slot.children];
    expect(badge.hasAttribute("data-reveal-yield")).toBe(true);
    expect(trailing.hasAttribute("data-reveal")).toBe(true);
    expect(
      trailing.querySelector('[aria-label="Mark as done"]'),
    ).not.toBeNull();
  });

  test("ends both occupants of the slot at the same edge", () => {
    const row = renderRow().querySelector('[data-slot="panel-item"]')!;
    const classes = row.className;
    expect(classes).toContain("[&_[data-slot=crossfade-stack]>*]:w-full");
    expect(classes).toContain("[&_[data-slot=crossfade-stack]>*]:justify-end");
  });

  test("draws the timestamp as quiet metadata, not at the title's weight", () => {
    const badge = renderRow().querySelector(
      `.${CSS.escape("text-body-small-lighter")}`,
    );
    expect(badge).not.toBeNull();
    expect(badge!.className).toContain("var(--content-tertiary)");
  });
});
