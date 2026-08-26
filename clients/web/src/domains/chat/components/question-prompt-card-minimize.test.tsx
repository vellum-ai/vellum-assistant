/**
 * Tests for the `QuestionPromptCard` minimized state (LUM-3390).
 *
 * The card sits between the transcript and the composer, so at full height it
 * covers the message it is asking about. Minimizing has to put the options out
 * of reach as well as out of sight: a collapsed row still answers a click and
 * still takes a hotkey unless something says otherwise, and either would submit
 * an answer the user never saw.
 *
 * The gesture itself is covered in `use-question-card-minimize.test.ts`; these
 * cover what the card does with it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

import type { QuestionResponseEntry } from "@/domains/chat/api/event-types";
import { QuestionPromptCard } from "@/domains/chat/components/question-prompt-card";
import type { QuestionEntry } from "@/types/interaction-ui-types";

const ENTRY: QuestionEntry = {
  id: "q1",
  question: "What should we build first for MarkOne?",
  description: "Pick the most useful starting point.",
  options: [
    { id: "offer", label: "Define the offer and positioning" },
    { id: "clients", label: "Choose the ideal clients" },
    { id: "acquisition", label: "Build the client acquisition system" },
    { id: "workflow", label: "Design the AI delivery workflow" },
  ],
};

/**
 * A `matchMedia` that can change its answer mid-test, which is the whole point
 * of the pointer gates below: the card subscribes rather than sampling once, so
 * a convertible folding into tablet mode has to reach a card already on screen.
 */
let pointerIsCoarse = false;
const mediaListeners = new Set<() => void>();

function installMatchMedia(): void {
  window.matchMedia = ((query: string) => ({
    matches: pointerIsCoarse && query.includes("coarse"),
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: () => void) => {
      mediaListeners.add(listener);
    },
    removeEventListener: (_type: string, listener: () => void) => {
      mediaListeners.delete(listener);
    },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function setPointer(coarse: boolean): void {
  pointerIsCoarse = coarse;
  act(() => {
    for (const listener of mediaListeners) {
      listener();
    }
  });
}

beforeEach(() => {
  pointerIsCoarse = false;
  mediaListeners.clear();
  installMatchMedia();
});

afterEach(() => {
  cleanup();
  pointerIsCoarse = false;
  mediaListeners.clear();
});

function renderCard(
  overrides: {
    entries?: QuestionEntry[];
    onSubmitAll?: (responses: QuestionResponseEntry[]) => void;
    onClose?: () => void;
  } = {},
) {
  return render(
    <QuestionPromptCard
      requestId="req-1"
      entries={overrides.entries ?? [ENTRY]}
      isSubmitting={false}
      onSubmitAll={overrides.onSubmitAll ?? (() => {})}
      onClose={overrides.onClose}
    />,
  );
}

/**
 * Whichever control currently carries the collapse state. Expanded that is the
 * header chevron; minimized it is the summary itself, which is named by its own
 * contents rather than a label, so `aria-expanded` is what identifies it in
 * both states.
 */
function toggleButton(): HTMLElement {
  const control = document.querySelector<HTMLElement>("[aria-expanded]");
  if (!control) {
    throw new Error("the card rendered no collapse control");
  }
  return control;
}

/**
 * The text a screen reader would reach, which is not the same as the text in
 * the DOM: both halves of the header crossfade stay mounted at zero height, and
 * so does the whole collapsed body.
 */
function accessibleText(root: Element): string {
  const out: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.trim();
      if (text) {
        out.push(text);
      }
      return;
    }
    if (!(node instanceof Element)) {
      return;
    }
    if (
      node.getAttribute("aria-hidden") === "true" ||
      node.hasAttribute("inert")
    ) {
      return;
    }
    node.childNodes.forEach(walk);
  };
  walk(root);
  return out.join(" | ");
}

/**
 * The numeric hint on each option row. Decorative, so it is the one
 * `aria-hidden` span inside an unselected option's button.
 */
function hotkeyBadges(container: HTMLElement): Element[] {
  return Array.from(
    container.querySelectorAll(
      'button[aria-label^="Option "] span[aria-hidden="true"]',
    ),
  );
}

/** The card's drag surface, which owns the touch handlers. */
function dragSurface(): HTMLElement {
  const el = document.querySelector<HTMLElement>(
    '[data-slot="question-card-surface"]',
  );
  if (!el) {
    throw new Error("the card rendered no drag surface");
  }
  return el;
}

/**
 * A downward drag past the commit threshold, released. `MINIMIZE_COMMIT_PX` is
 * 64, so 100px is comfortably a commit rather than a spring-back.
 */
function swipeDown(): void {
  const surface = dragSurface();
  const at = (clientY: number) => [{ identifier: 1, clientX: 0, clientY }];
  fireEvent.touchStart(surface, { touches: at(200) });
  fireEvent.touchMove(surface, { touches: at(300) });
  fireEvent.touchEnd(surface, { changedTouches: at(300) });
}

function collapsibleRegion(): HTMLElement {
  const id = toggleButton().getAttribute("aria-controls");
  expect(id).toBeTruthy();
  const region = document.getElementById(id!);
  expect(region).not.toBeNull();
  return region!;
}

describe("QuestionPromptCard minimize", () => {
  test("renders expanded, with the minimize control open", () => {
    renderCard();

    expect(toggleButton().getAttribute("aria-expanded")).toBe("true");
    expect(toggleButton().getAttribute("aria-label")).toBe("Minimize question");
    expect(
      screen.getByText("Pick the most useful starting point."),
    ).toBeDefined();
    expect(collapsibleRegion().hasAttribute("inert")).toBe(false);
  });

  test("the minimize button collapses the body and swaps in a summary", () => {
    renderCard();

    fireEvent.click(toggleButton());

    expect(toggleButton().getAttribute("aria-expanded")).toBe("false");
    // The question itself stays: it is what the summary row is a summary of.
    expect(
      screen.getByText("What should we build first for MarkOne?"),
    ).toBeDefined();
    expect(screen.getByText(/4 options/)).toBeDefined();
  });

  test("the summary line is announced only once the body it stands in for is gone", () => {
    const { container } = renderCard();

    expect(accessibleText(container)).not.toContain("4 options");
    expect(accessibleText(container)).toContain(
      "Pick the most useful starting point.",
    );

    fireEvent.click(toggleButton());

    expect(accessibleText(container)).toContain("4 options");
    expect(accessibleText(container)).not.toContain(
      "Pick the most useful starting point.",
    );
    // The options go with it: a row read out here is one the user cannot see.
    expect(accessibleText(container)).not.toContain("Choose the ideal clients");
  });

  test("the collapsed body is inert, so its rows leave the tab order too", () => {
    renderCard();

    fireEvent.click(toggleButton());

    expect(collapsibleRegion().hasAttribute("inert")).toBe(true);
  });

  test("tapping a minimized card's header reopens it", () => {
    renderCard();

    fireEvent.click(toggleButton());
    expect(toggleButton().getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(
      screen.getByText("What should we build first for MarkOne?"),
    );

    expect(toggleButton().getAttribute("aria-expanded")).toBe("true");
  });

  test("tapping an expanded card's header does not minimize it", () => {
    renderCard();

    fireEvent.click(
      screen.getByText("What should we build first for MarkOne?"),
    );

    expect(toggleButton().getAttribute("aria-expanded")).toBe("true");
  });

  test("option hotkeys stop answering once the card is minimized", () => {
    const submitted: QuestionResponseEntry[][] = [];
    renderCard({ onSubmitAll: (r) => submitted.push(r) });

    fireEvent.click(toggleButton());
    fireEvent.keyDown(window, { key: "1" });

    expect(submitted).toHaveLength(0);

    // Reopened, the same key answers as it always did.
    fireEvent.click(toggleButton());
    fireEvent.keyDown(window, { key: "1" });

    expect(submitted).toHaveLength(1);
  });

  test("Escape still closes a minimized card", () => {
    let closed = 0;
    renderCard({ onClose: () => (closed += 1) });

    fireEvent.click(toggleButton());
    fireEvent.keyDown(window, { key: "Escape" });

    expect(closed).toBe(1);
  });

  test("the pager leaves with the rows it pages between", () => {
    renderCard({ entries: [ENTRY, { ...ENTRY, id: "q2" }] });

    expect(
      screen.queryByRole("button", { name: "Next question" }),
    ).not.toBeNull();

    fireEvent.click(toggleButton());

    expect(screen.queryByRole("button", { name: "Next question" })).toBeNull();
  });

  test("a batch announces its position rather than drawing it", () => {
    // The pager offers movement without saying where from, and the header has
    // a wrapped question to fit on a phone. The count is carried by a status
    // line a reader hears and a screen does not show.
    renderCard({ entries: [ENTRY, { ...ENTRY, id: "q2" }] });

    const status = screen.getByRole("status");
    expect(status.textContent).toBe("1 of 2");
    expect(status.className).toContain("sr-only");

    fireEvent.click(screen.getByRole("button", { name: "Next question" }));

    // A live region, so paging is heard rather than only reachable.
    expect(screen.getByRole("status").textContent).toBe("2 of 2");
  });

  test("a minimized batch has no position to report", () => {
    renderCard({ entries: [ENTRY, { ...ENTRY, id: "q2" }] });

    fireEvent.click(toggleButton());

    expect(screen.queryByRole("status")).toBeNull();
  });

  test("a single question announces no position at all", () => {
    renderCard();

    expect(screen.queryByRole("status")).toBeNull();
  });

  test("a minimized card keeps no chevron of its own", () => {
    const { container } = renderCard({ onClose: () => {} });

    fireEvent.click(toggleButton());

    expect(
      Array.from(container.querySelectorAll("button")).filter((button) => {
        const label = button.getAttribute("aria-label");
        return label === "Minimize question" || label === "Reopen question";
      }),
    ).toHaveLength(0);
    // What reopens the card is the summary itself, not a second chevron
    // pointing the other way.
    expect(toggleButton().tagName).not.toBe("BUTTON");
  });

  test("a minimized card is announced as the question it stands for", () => {
    renderCard();

    fireEvent.click(toggleButton());

    // Descendants of a `role="button"` are flattened into its accessible name,
    // so an `aria-label` here would trade the question and the option count for
    // a generic phrase and a reader would lose both. Name-from-content is what
    // keeps them, and it is the whole reason the label is absent.
    expect(
      screen.getByRole("button", {
        name: /What should we build first for MarkOne\?.*4 options/,
      }),
    ).toBeDefined();
  });

  test("the keyboard reopens a minimized card", () => {
    renderCard();

    fireEvent.click(toggleButton());
    expect(toggleButton().getAttribute("aria-expanded")).toBe("false");

    // The summary is a `role="button"` div, so it handles the keystrokes a
    // real button would have taken care of on its own.
    fireEvent.keyDown(toggleButton(), { key: "Enter" });

    expect(toggleButton().getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(toggleButton());
    fireEvent.keyDown(toggleButton(), { key: " " });

    expect(toggleButton().getAttribute("aria-expanded")).toBe("true");
  });

  test("focus follows the control that replaces the one it was on", () => {
    renderCard();

    const chevron = toggleButton();
    chevron.focus();
    fireEvent.click(chevron);

    // The chevron has just unmounted. Left alone, focus would land on the
    // document body and the next Tab would restart from the top of the page.
    expect(document.activeElement).toBe(toggleButton());

    fireEvent.keyDown(toggleButton(), { key: "Enter" });

    // And back: the summary keeps the DOM node but loses its role and tab
    // stop, so focus has to move to the chevron that took over from it.
    expect(document.activeElement).toBe(toggleButton());
    expect(toggleButton().tagName).toBe("BUTTON");
  });

  test("mounting does not pull focus into the card", () => {
    renderCard();

    expect(document.activeElement).toBe(document.body);
  });

  test("a swipe leaves focus where the user put it", () => {
    // A thumb collapses the card while the free-text row holds focus. The
    // gesture crosses the same state the chevron does, but focus is not its to
    // move: it belongs to wherever the user left it.
    setPointer(true);
    renderCard();
    screen.getByLabelText("Type a different answer").focus();

    swipeDown();

    expect(toggleButton().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).not.toBe(toggleButton());
  });

  test("a swipe carries focus when it is the focused control being retired", () => {
    // The hybrid keyboard-and-touch case: focus has been tabbed onto the
    // chevron, and a thumb then swipes the card shut underneath it. The
    // chevron unmounts, so focus has to land on what replaced it.
    setPointer(true);
    renderCard();
    toggleButton().focus();
    expect(document.activeElement).toBe(toggleButton());

    swipeDown();

    expect(toggleButton().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggleButton());
  });

  test("the hotkey badges follow the pointer changing under a mounted card", () => {
    // The pointer read is subscribed rather than sampled once, so a convertible
    // folding into tablet mode reaches a card that is already on screen.
    // `useSwipeEngine` reads the same signal, so the badges standing down is
    // the gesture arming.
    const { container } = renderCard();

    expect(hotkeyBadges(container)).not.toHaveLength(0);

    setPointer(true);
    expect(hotkeyBadges(container)).toHaveLength(0);

    setPointer(false);
    expect(hotkeyBadges(container)).not.toHaveLength(0);
  });
});
