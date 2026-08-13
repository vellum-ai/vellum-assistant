/**
 * Tests for `ContextWindowIndicator`'s opt-in gate and its presentation axis.
 *
 * The ring is hidden unless the user turns it on in Settings → General →
 * Preferences: a gauge filling toward "full" reads as an impending failure
 * even though the assistant compacts its own context. These tests pin both
 * halves of that contract, silent by default and visible once opted in.
 *
 * They also pin which axis chooses the presentation. The ring reveals its
 * detail on hover under a mouse and opens a tappable sheet under a thumb,
 * which is input capability, not window size: see `docs/PLATFORM_ADAPTATION.md`.
 * Uses happy-dom via the bun:test preload configured in `web/bunfig.toml`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { cleanup, render, screen } from "@testing-library/react";

import { viewportAxesStub } from "@/hooks/viewport-axes.test-helper";

let indicatorEnabled = false;

mock.module("@/utils/composer-settings", () => ({
  showContextWindowIndicator: {
    useValue: () => indicatorEnabled,
    save: () => {},
  },
}));

import { ContextWindowIndicator } from "@/domains/chat/components/context-window-indicator";

const USAGE = { tokens: 90_000, maxTokens: 200_000, fillRatio: 0.45 };

const viewport = viewportAxesStub();

beforeEach(() => {
  indicatorEnabled = false;
  viewport.set({ narrow: false, coarsePointer: false });
});

afterEach(() => {
  cleanup();
  viewport.restore();
});

describe("ContextWindowIndicator", () => {
  test("renders nothing while the preference is off", () => {
    // GIVEN usage that would otherwise paint a 45%-full ring
    // WHEN the opt-in preference is off (the shipped default)
    const { container } = render(
      <ContextWindowIndicator usage={USAGE} assistantName="Vellum" />,
    );

    // THEN the composer gets no ring at all
    expect(container.firstChild).toBeNull();
    expect(screen.queryByLabelText(/Context window/)).toBeNull();
  });

  test("renders the ring once the preference is on", () => {
    // GIVEN the user has opted in
    indicatorEnabled = true;

    // WHEN the same usage renders
    render(<ContextWindowIndicator usage={USAGE} assistantName="Vellum" />);

    // THEN the ring appears, labelled with the rounded fill percentage
    expect(screen.getByLabelText("Context window 45% full")).toBeDefined();
  });

  test("stays hidden when opted in but usage is unknown", () => {
    // GIVEN the preference is on but no usage has streamed in yet
    indicatorEnabled = true;

    // WHEN the indicator renders without usage
    const { container } = render(
      <ContextWindowIndicator usage={null} assistantName="Vellum" />,
    );

    // THEN there is nothing to show
    expect(container.firstChild).toBeNull();
  });
});

describe("ContextWindowIndicator presentation axis", () => {
  const RING_NAME = "Context window 45% full";

  /**
   * Both branches render a button, so element type cannot tell them apart.
   * What distinguishes them is whether the control opens something on
   * activation: the sheet trigger announces `aria-haspopup="dialog"`, the
   * tooltip trigger announces nothing because a tooltip is revealed, not
   * opened. That is also the contract a screen-reader user hears, so it is
   * the right thing to assert.
   */
  function opensASheet(): boolean {
    const trigger = screen.getByRole("button", { name: RING_NAME });
    return trigger.getAttribute("aria-haspopup") === "dialog";
  }

  /**
   * Whichever branch renders, exactly one element carries the ring's name and
   * exactly one is focusable. A labelled, tabbable glyph nested inside a
   * labelled, tabbable trigger announces twice and costs two tab stops.
   */
  function expectOneNamedTabStop(container: HTMLElement): void {
    expect(screen.getAllByLabelText(RING_NAME)).toHaveLength(1);
    expect(container.querySelectorAll("[tabindex], button")).toHaveLength(1);
  }

  beforeEach(() => {
    indicatorEnabled = true;
  });

  test("a roomy touch window still gets a tappable trigger", () => {
    // GIVEN a tablet in landscape: a coarse pointer with plenty of room.
    // Roomy and thumb-driven is the combination the two axes only disagree
    // on, and the one a width check answers wrongly.
    viewport.set({ narrow: false, coarsePointer: true });

    // WHEN the ring renders
    const { container } = render(
      <ContextWindowIndicator
        usage={USAGE}
        assistantName="Vellum"
        onClearContext={() => {}}
      />,
    );

    // THEN the ring is a real trigger a thumb can hit, not a hover target
    expect(opensASheet()).toBe(true);
    expectOneNamedTabStop(container);
  });

  test("a phone-sized touch window gets the same tappable trigger", () => {
    // GIVEN a phone in portrait: coarse and narrow
    viewport.set({ narrow: true, coarsePointer: true });

    // WHEN the ring renders
    const { container } = render(
      <ContextWindowIndicator usage={USAGE} assistantName="Vellum" />,
    );

    // THEN it is the same presentation as the roomy touch case above
    expect(opensASheet()).toBe(true);
    expectOneNamedTabStop(container);
  });

  test("a narrow mouse window keeps the hover presentation", () => {
    // GIVEN a desktop window dragged narrow, or an Electron shell: still a
    // mouse. Width alone must not push a hover-capable pointer to the sheet.
    viewport.set({ narrow: true, coarsePointer: false });

    // WHEN the ring renders
    const { container } = render(
      <ContextWindowIndicator usage={USAGE} assistantName="Vellum" />,
    );

    // THEN the control reveals a tooltip rather than opening a sheet, while
    // remaining named and keyboard-reachable, which is how a desktop user
    // without a mouse gets at it.
    expect(opensASheet()).toBe(false);
    expectOneNamedTabStop(container);
  });
});
