/**
 * Tests for the `Tooltip` convenience wrapper and its compound `Content`.
 *
 * Rendered to static markup: the tooltip content itself only mounts on hover,
 * so what is assertable here is the trigger, which is the part other
 * primitives compose with.
 *
 * There is no DOM here to answer a media query, so the hover capability is
 * driven by swapping the module that reads it. Static markup takes the
 * hook's server value, which is hover-capable, so the unswapped tests are
 * also the hover-capable half.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import * as hoverCapability from "../utils/hover-capability";
import { Tooltip } from "./tooltip";

/* Captured before any swap, because the namespace object is live: reading it
   back after one would hand the swap in as the restore. */
const realUseHoverCapable = hoverCapability.useHoverCapable;

function setHoverCapable(hoverCapable: boolean) {
  mock.module("../utils/hover-capability", () => ({
    ...hoverCapability,
    useHoverCapable: () => hoverCapable,
  }));
}

afterEach(() => {
  mock.module("../utils/hover-capability", () => ({
    ...hoverCapability,
    useHoverCapable: realUseHoverCapable,
  }));
});

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

  test("wraps the child in a trigger where the device can hover", () => {
    setHoverCapable(true);

    const html = renderToStaticMarkup(
      <Tooltip content="Preferences">
        <button type="button">Open</button>
      </Tooltip>,
    );

    expect(html).toContain('data-slot="tooltip-trigger"');
  });

  test("renders the child bare where the device cannot hover", () => {
    setHoverCapable(false);

    const html = renderToStaticMarkup(
      <Tooltip content="Preferences">
        <button type="button">Open</button>
      </Tooltip>,
    );

    expect(html).toBe('<button type="button">Open</button>');
  });

  /* Suppression must not cost the composition the wrapper exists for: the
     collapsed rail's tiles reach their element through this. */
  test("still forwards props to the child where the device cannot hover", () => {
    setHoverCapable(false);

    const html = renderToStaticMarkup(
      <Tooltip content="Vex Ops" data-slot="context-menu-trigger" id="probe">
        <button type="button">Open</button>
      </Tooltip>,
    );

    expect(html).toContain('data-slot="context-menu-trigger"');
    expect(html).toContain('id="probe"');
  });
});

/* The compound API is the other way in, so it is gated at `Content` rather
   than only at the wrapper. Asserted on a `Content` with no `Root` above it:
   Radix demands a provider, so reaching it at all throws. Nothing rendering
   is therefore also proof that nothing was mounted on the way. */
describe("Tooltip.Content", () => {
  test("mounts nothing where the device cannot hover", () => {
    setHoverCapable(false);

    expect(
      renderToStaticMarkup(<Tooltip.Content>Context left</Tooltip.Content>),
    ).toBe("");
  });

  test("reaches Radix where the device can hover", () => {
    setHoverCapable(true);

    expect(() =>
      renderToStaticMarkup(<Tooltip.Content>Context left</Tooltip.Content>),
    ).toThrow();
  });
});
