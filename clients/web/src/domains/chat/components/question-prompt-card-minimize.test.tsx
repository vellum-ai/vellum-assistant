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

function toggleButton(): HTMLElement {
  return screen.getByRole("button", {
    name: /Minimize question|Reopen question/,
  });
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
    expect(toggleButton().getAttribute("aria-label")).toBe("Reopen question");
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

  test("the swipe grabber renders only where a swipe can happen", () => {
    const GRABBER = '[data-slot="question-card-grabber"]';

    const fine = renderCard();
    expect(fine.container.querySelector(GRABBER)).toBeNull();

    cleanup();
    setPointer(true);
    const coarse = renderCard();
    expect(coarse.container.querySelector(GRABBER)).not.toBeNull();
  });

  test("the grabber follows the pointer changing under a mounted card", () => {
    const GRABBER = '[data-slot="question-card-grabber"]';
    const { container } = renderCard();

    expect(container.querySelector(GRABBER)).toBeNull();

    // A convertible folding into tablet mode, with the card already on screen.
    setPointer(true);
    expect(container.querySelector(GRABBER)).not.toBeNull();

    setPointer(false);
    expect(container.querySelector(GRABBER)).toBeNull();
  });
});
