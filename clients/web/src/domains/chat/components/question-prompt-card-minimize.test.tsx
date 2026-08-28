/**
 * Tests for the `QuestionPromptCard` collapse (LUM-3390) and the width that
 * decides whether it is offered at all.
 *
 * The card sits between the transcript and the composer, so on a narrow card it
 * covers the message it is asking about. Collapsing has to put the options out
 * of reach as well as out of sight: a collapsed row still answers a click and
 * still takes a hotkey unless something says otherwise, and either would submit
 * an answer the user never saw. A card wide enough to sit beside the transcript
 * has nothing to collapse for and offers no control to do it with, which makes
 * "wide and collapsed" a state the card must never reach.
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

/**
 * happy-dom ships a `ResizeObserver` whose methods do nothing, and no layout
 * engine behind `getBoundingClientRect`, so a card here measures zero and reads
 * as narrow. That is the useful default: the roomy layout is the one that needs
 * room proven. Width changes are driven by holding the observer's own callback
 * and calling it, rather than by remounting the card, because the collapse
 * state lives in `useState` and a remount would reset it and pass the
 * auto-expand assertions for the wrong reason.
 */
interface StubbedObserver {
  callback: ResizeObserverCallback;
  targets: Set<Element>;
}

const resizeObservers = new Set<StubbedObserver>();
let originalResizeObserver: typeof ResizeObserver;

function installResizeObserver(): void {
  originalResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    private entry: StubbedObserver;
    constructor(callback: ResizeObserverCallback) {
      this.entry = { callback, targets: new Set() };
      resizeObservers.add(this.entry);
    }
    observe(target: Element) {
      this.entry.targets.add(target);
    }
    unobserve(target: Element) {
      this.entry.targets.delete(target);
    }
    disconnect() {
      resizeObservers.delete(this.entry);
    }
  } as unknown as typeof ResizeObserver;
}

/**
 * Report `px` as every observed element's inline size. Other components in the
 * tree build their own observers, so each is notified about its own target
 * rather than whichever was constructed last.
 */
function setCardWidth(px: number): void {
  act(() => {
    for (const observer of resizeObservers) {
      for (const target of observer.targets) {
        observer.callback(
          [
            {
              target,
              borderBoxSize: [{ inlineSize: px, blockSize: 0 }],
            } as unknown as ResizeObserverEntry,
          ],
          {} as ResizeObserver,
        );
      }
    }
  });
}

/** Comfortably past the release band, so a narrow card becomes roomy. */
const ROOMY_PX = 800;
/** Comfortably below the threshold, so a roomy card becomes narrow again. */
const CRAMPED_PX = 380;

beforeEach(() => {
  pointerIsCoarse = false;
  mediaListeners.clear();
  installMatchMedia();
  resizeObservers.clear();
  installResizeObserver();
});

afterEach(() => {
  cleanup();
  pointerIsCoarse = false;
  mediaListeners.clear();
  resizeObservers.clear();
  globalThis.ResizeObserver = originalResizeObserver;
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
 * The collapse chevron, which a narrow card carries in both states and a roomy
 * card carries in neither. `aria-expanded` is what identifies it, since its
 * label changes with the direction it points.
 */
function toggleButton(): HTMLElement {
  const control = document.querySelector<HTMLElement>("[aria-expanded]");
  if (!control) {
    throw new Error("the card rendered no collapse control");
  }
  return control;
}

function queryToggleButton(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[aria-expanded]");
}

/**
 * The text a screen reader would reach, which is not the same as the text in
 * the DOM: the collapsed body stays mounted at zero height.
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

/** How the header is arranged: a meta row of its own, or one line with it. */
function headerLayout(): string | null {
  return (
    document.querySelector<HTMLElement>("[data-header]")?.dataset.header ?? null
  );
}

/** The region the chevron collapses, addressed without going through it. */
function collapsibleRegion(): HTMLElement {
  const el = document.querySelector<HTMLElement>(
    '[data-slot="question-card-body"]',
  );
  if (!el) {
    throw new Error("the card rendered no collapsible body");
  }
  return el;
}

describe("QuestionPromptCard collapse", () => {
  test("renders expanded, with the collapse control open", () => {
    renderCard();

    expect(toggleButton().getAttribute("aria-expanded")).toBe("true");
    expect(toggleButton().getAttribute("aria-label")).toBe("Minimize question");
    expect(toggleButton().getAttribute("aria-controls")).toBe(
      collapsibleRegion().id,
    );
    expect(
      screen.getByText("Pick the most useful starting point."),
    ).toBeDefined();
    expect(collapsibleRegion().hasAttribute("inert")).toBe(false);
  });

  test("the chevron collapses the body and leaves the header standing", () => {
    const { container } = renderCard();

    fireEvent.click(toggleButton());

    expect(toggleButton().getAttribute("aria-expanded")).toBe("false");
    // Both header lines survive the collapse: they are what a collapsed card
    // is, rather than a stand-in for it.
    expect(accessibleText(container)).toContain(
      "What should we build first for MarkOne?",
    );
    expect(accessibleText(container)).toContain(
      "Pick the most useful starting point.",
    );
    // The options go with the body: a row read out here is one the user
    // cannot see.
    expect(accessibleText(container)).not.toContain("Choose the ideal clients");
  });

  test("the collapsed body is inert, so its rows leave the tab order too", () => {
    renderCard();

    fireEvent.click(toggleButton());

    expect(collapsibleRegion().hasAttribute("inert")).toBe(true);
  });

  test("tapping a collapsed card's header reopens it", () => {
    renderCard();

    fireEvent.click(toggleButton());
    expect(toggleButton().getAttribute("aria-expanded")).toBe("false");

    // The whole header is the target, so a thumb has more than the chevron to
    // land on.
    fireEvent.click(
      screen.getByText("What should we build first for MarkOne?"),
    );

    expect(toggleButton().getAttribute("aria-expanded")).toBe("true");
  });

  test("tapping an expanded card's header does not collapse it", () => {
    renderCard();

    fireEvent.click(
      screen.getByText("What should we build first for MarkOne?"),
    );

    expect(toggleButton().getAttribute("aria-expanded")).toBe("true");
  });

  test("option hotkeys stop answering once the card is collapsed", () => {
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

  test("Escape closes the card in every state it has", () => {
    let closed = 0;
    renderCard({ onClose: () => (closed += 1) });

    fireEvent.click(toggleButton());
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closed).toBe(1);

    fireEvent.click(toggleButton());
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closed).toBe(2);

    // Roomy, where it is the only way out the card offers at all.
    setCardWidth(ROOMY_PX);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closed).toBe(3);
  });

  test("the pager stays behind when the rows it pages between leave", () => {
    renderCard({ entries: [ENTRY, { ...ENTRY, id: "q2" }] });

    fireEvent.click(toggleButton());

    // Paging a collapsed card changes the question its header shows, which is
    // the one thing still on screen to change.
    expect(
      screen.queryByRole("button", { name: "Next question" }),
    ).not.toBeNull();
  });

  test("a batch draws its position and announces every change to it", () => {
    renderCard({ entries: [ENTRY, { ...ENTRY, id: "q2" }] });

    const status = screen.getByRole("status");
    expect(status.textContent).toBe("1 of 2");
    // Drawn, not hidden from sight and read only to a screen reader.
    expect(status.className).not.toContain("sr-only");

    fireEvent.click(screen.getByRole("button", { name: "Next question" }));

    // A live region, so paging is heard rather than only seen.
    expect(screen.getByRole("status").textContent).toBe("2 of 2");
  });

  test("a collapsed batch still reports its position", () => {
    renderCard({ entries: [ENTRY, { ...ENTRY, id: "q2" }] });

    fireEvent.click(toggleButton());

    expect(screen.getByRole("status").textContent).toBe("1 of 2");
  });

  test("a single question reports no position at all", () => {
    renderCard();

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button", { name: "Next question" })).toBeNull();
  });

  test("a collapsed card keeps one chevron, turned the other way", () => {
    renderCard();

    fireEvent.click(toggleButton());

    expect(toggleButton().tagName).toBe("BUTTON");
    expect(toggleButton().getAttribute("aria-label")).toBe("Reopen question");
    expect(
      Array.from(document.querySelectorAll("button")).filter((button) => {
        const label = button.getAttribute("aria-label");
        return label === "Minimize question" || label === "Reopen question";
      }),
    ).toHaveLength(1);
  });

  test("the chevron says which question it reopens", () => {
    const { container } = renderCard();

    fireEvent.click(toggleButton());

    // Its own label says what the press does. The question is header content
    // rather than part of that name, so a reader landing on the control would
    // otherwise have no idea which question it stands for.
    const describedBy = toggleButton().getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const description = container.ownerDocument.getElementById(describedBy!);
    expect(description?.textContent).toBe(
      "What should we build first for MarkOne?",
    );
  });

  test("the chevron is a real button, so the browser owns its keystrokes", () => {
    renderCard();

    // `fireEvent.keyDown` does not synthesize the activation click a browser
    // gives a real button, so the guarantee worth pinning here is that this is
    // one, rather than an element that has to hand-roll Enter and Space.
    expect(toggleButton().tagName).toBe("BUTTON");

    fireEvent.click(toggleButton());
    expect(toggleButton().getAttribute("aria-expanded")).toBe("false");
  });

  test("the chevron keeps focus across a collapse and back", () => {
    renderCard();

    toggleButton().focus();
    expect(document.activeElement).toBe(toggleButton());

    fireEvent.click(toggleButton());

    // One button across both states, so the DOM keeps focus on it rather than
    // dropping to the body and restarting the next Tab from the top of the
    // page.
    expect(document.activeElement).toBe(toggleButton());

    fireEvent.click(toggleButton());
    expect(document.activeElement).toBe(toggleButton());
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

describe("QuestionPromptCard width", () => {
  test("a roomy card offers no collapse, beside a pager that stays", () => {
    // Batched, so the cluster the chevron sits in is on screen either way and
    // the chevron leaving is the chevron's own doing.
    renderCard({ entries: [ENTRY, { ...ENTRY, id: "q2" }] });
    expect(queryToggleButton()).not.toBeNull();

    setCardWidth(ROOMY_PX);

    expect(queryToggleButton()).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Next question" }),
    ).not.toBeNull();
    expect(collapsibleRegion().hasAttribute("inert")).toBe(false);
  });

  test("a roomy single question carries no header controls at all", () => {
    renderCard();
    expect(queryToggleButton()).not.toBeNull();

    setCardWidth(ROOMY_PX);

    expect(queryToggleButton()).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Previous question" }),
    ).toBeNull();
  });

  test("a card collapsed while narrow opens once it has the room", () => {
    const { container } = renderCard();

    fireEvent.click(toggleButton());
    expect(collapsibleRegion().hasAttribute("inert")).toBe(true);

    setCardWidth(ROOMY_PX);

    // Nothing left to reopen it with, so it cannot stay shut.
    expect(collapsibleRegion().hasAttribute("inert")).toBe(false);
    expect(accessibleText(container)).toContain("Choose the ideal clients");
  });

  test("a card held open by its width does not spring shut when the room goes", () => {
    renderCard();

    fireEvent.click(toggleButton());
    setCardWidth(ROOMY_PX);
    setCardWidth(CRAMPED_PX);

    expect(toggleButton().getAttribute("aria-expanded")).toBe("true");
    expect(collapsibleRegion().hasAttribute("inert")).toBe(false);
  });

  test("a swipe cannot collapse a roomy card", () => {
    setPointer(true);
    renderCard();
    setCardWidth(ROOMY_PX);

    swipeDown();

    expect(queryToggleButton()).toBeNull();
    expect(collapsibleRegion().hasAttribute("inert")).toBe(false);
  });

  test("a roomy card leaves vertical panning to the browser", () => {
    renderCard();
    // A narrow card claims the axis it drags on, or the browser can cancel the
    // touch stream mid-gesture and the collapse commits nothing.
    expect(dragSurface().className).toContain("touch-action");

    setCardWidth(ROOMY_PX);

    // Roomy it drags on no axis, so holding the declaration would only stop a
    // finger that wanted to scroll the transcript.
    expect(dragSurface().className).not.toContain("touch-action");
  });

  test("a lone chevron rides on the question's line rather than a row of its own", () => {
    // With no pager to carry, a meta row would be a whole line holding one
    // 24px control, pushing the question down for nothing.
    renderCard();
    expect(headerLayout()).toBe("inline");

    fireEvent.click(toggleButton());
    expect(headerLayout()).toBe("inline");
  });

  test("a pager earns the meta row it sits on", () => {
    renderCard({ entries: [ENTRY, { ...ENTRY, id: "q2" }] });

    expect(headerLayout()).toBe("stacked");

    // Until the card is roomy enough to put the whole cluster beside the
    // question.
    setCardWidth(ROOMY_PX);
    expect(headerLayout()).toBe("inline");
  });

  test("only a card that can be dragged takes selection away from a thumb", () => {
    setPointer(true);
    renderCard();

    // Narrow, the gesture competes with a long-press, so selection stands down.
    const header = document.querySelector<HTMLElement>("[data-header]")!;
    expect(header.className).toContain("select-none");

    setCardWidth(ROOMY_PX);

    // Roomy the card holds still, so a long-press on the question is free.
    expect(
      document.querySelector<HTMLElement>("[data-header]")!.className,
    ).not.toContain("select-none");
  });

  test("the header reflows without remounting what it sits above", () => {
    renderCard();
    const before = collapsibleRegion();

    setCardWidth(ROOMY_PX);
    setCardWidth(CRAMPED_PX);

    // The collapse eases on `grid-template-rows`, which a freshly mounted node
    // has no previous value to interpolate from. A reflow that remounted this
    // one would make the next collapse jump instead of run.
    expect(collapsibleRegion()).toBe(before);
  });
});
