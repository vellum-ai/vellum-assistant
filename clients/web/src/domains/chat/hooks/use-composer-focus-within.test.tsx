/**
 * Tests for `useComposerFocusWithin`.
 *
 * The hook listens on `document`, so the fixture builds real detached-then-
 * attached nodes rather than rendering a component tree: what matters is which
 * element the focus event reports, not what drew it.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { cleanup, fireEvent, renderHook } from "@testing-library/react";

import { useComposerFocusWithin } from "@/domains/chat/hooks/use-composer-focus-within";

function setupDom() {
  const container = document.createElement("div");
  const textarea = document.createElement("textarea");
  const micButton = document.createElement("button");
  container.append(textarea, micButton);

  const outside = document.createElement("button");
  document.body.append(container, outside);

  return { container, textarea, micButton, outside };
}

function renderFocusWithin(container: HTMLElement) {
  const containerRef = { current: container };
  return renderHook(() => useComposerFocusWithin(containerRef));
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("useComposerFocusWithin", () => {
  test("reports focus landing inside the container", () => {
    // GIVEN a composer container that does not hold focus
    const { container, textarea } = setupDom();
    const { result } = renderFocusWithin(container);
    expect(result.current).toBe(false);

    // WHEN focus lands on a child
    fireEvent.focusIn(textarea);

    // THEN the container reports focus within
    expect(result.current).toBe(true);
  });

  test("stays true while focus moves between children", () => {
    // GIVEN focus on the textarea
    const { container, textarea, micButton } = setupDom();
    const { result } = renderFocusWithin(container);
    fireEvent.focusIn(textarea);

    // WHEN focus moves to the mic button, which fires focusout then focusin
    fireEvent.focusOut(textarea, { relatedTarget: micButton });
    fireEvent.focusIn(micButton);

    // THEN the row-level flag never dropped
    expect(result.current).toBe(true);
  });

  test("clears when focus lands outside the container", () => {
    // GIVEN focus on the textarea
    const { container, textarea, outside } = setupDom();
    const { result } = renderFocusWithin(container);
    fireEvent.focusIn(textarea);

    // WHEN focus moves to an element outside
    fireEvent.focusOut(textarea, { relatedTarget: outside });
    fireEvent.focusIn(outside);

    // THEN focus-within is false
    expect(result.current).toBe(false);
  });

  test("clears on a blur to the body", () => {
    // GIVEN focus on the textarea
    const { container, textarea } = setupDom();
    const { result } = renderFocusWithin(container);
    fireEvent.focusIn(textarea);

    // WHEN focus leaves with no landing element, as the iOS keyboard dismiss does
    fireEvent.focusOut(textarea, { relatedTarget: null });

    // THEN focus-within is false
    expect(result.current).toBe(false);
  });

  test("seeds from the already-focused element on mount", () => {
    // GIVEN a composer child that holds focus before the hook mounts
    const { container, textarea } = setupDom();
    textarea.focus();

    // WHEN the hook mounts
    const { result } = renderFocusWithin(container);

    // THEN it reports focus without waiting for a focus round-trip
    expect(result.current).toBe(true);
  });

  test("removes its document listeners on unmount", () => {
    // GIVEN a mounted hook
    const { container } = setupDom();
    const removeEventListener = spyOn(document, "removeEventListener");
    const { unmount } = renderFocusWithin(container);

    // WHEN the consumer unmounts
    unmount();

    // THEN both document listeners are detached
    const events = removeEventListener.mock.calls.map(([type]) => type);
    expect(events).toContain("focusin");
    expect(events).toContain("focusout");
    removeEventListener.mockRestore();
  });
});
