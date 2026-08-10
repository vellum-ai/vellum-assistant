/**
 * Tests for the `Tooltip` convenience wrapper.
 *
 * Rendered to static markup: the tooltip content itself only mounts on hover,
 * so what is assertable here is the trigger, which is the part other
 * primitives compose with.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Tooltip } from "./tooltip";

describe("Tooltip", () => {
  test("renders its child as the trigger, with no wrapper element", () => {
    const html = renderToStaticMarkup(
      <Tooltip content="Preferences">
        <button type="button">Open</button>
      </Tooltip>,
    );

    expect(html).toContain("<button");
    expect(html).toContain("Open");
  });

  /* The reason this wrapper forwards anything at all. An outer primitive that
     composes through `asChild` (`ContextMenu.Trigger`, `Popover.Trigger`)
     clones its child with handlers and data attributes; a tooltip that kept
     them would leave the element with a tooltip and none of the behaviour
     wrapped around it. The sidebar's collapsed rail depends on this: its tiles
     carry a tooltip and a right-click menu at once. */
  test("forwards props to the trigger so an outer asChild primitive composes", () => {
    const html = renderToStaticMarkup(
      <Tooltip content="Vex Ops" data-slot="context-menu-trigger" id="probe">
        <button type="button">Open</button>
      </Tooltip>,
    );

    expect(html).toContain('data-slot="context-menu-trigger"');
    expect(html).toContain('id="probe"');
  });
});
