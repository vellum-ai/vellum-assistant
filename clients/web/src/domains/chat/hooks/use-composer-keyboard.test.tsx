/**
 * Tests for `useComposerKeyboard`'s host-focus claim loop: a new-chat
 * request focuses the live textarea, and a remount of that node (empty-state
 * chrome settling) must not leave the caret on `<body>`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { useRef } from "react";
import { act, cleanup, render } from "@testing-library/react";

import {
  consumePendingComposerFocus,
  requestComposerFocus,
} from "@/domains/chat/composer-focus";
import { useComposerKeyboard } from "@/domains/chat/hooks/use-composer-keyboard";

function Harness({ textareaKey }: { textareaKey: string }) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  useComposerKeyboard(inputRef);
  return <textarea key={textareaKey} ref={inputRef} />;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

afterEach(() => {
  consumePendingComposerFocus();
  cleanup();
});

describe("useComposerKeyboard host focus", () => {
  test("focuses the composer textarea when a focus request fires", () => {
    const { container } = render(<Harness textareaKey="a" />);
    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();

    act(() => {
      requestComposerFocus();
    });
    expect(document.activeElement).toBe(textarea);
  });

  test("reclaims the remounted textarea while the claim window is open", async () => {
    const { container, rerender } = render(<Harness textareaKey="a" />);
    const first = container.querySelector("textarea");
    expect(first).not.toBeNull();

    act(() => {
      requestComposerFocus();
    });
    expect(document.activeElement).toBe(first);

    rerender(<Harness textareaKey="b" />);
    const second = container.querySelector("textarea");
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);

    await act(async () => {
      await nextFrame();
      await nextFrame();
    });
    expect(document.activeElement).toBe(second);
  });
});
