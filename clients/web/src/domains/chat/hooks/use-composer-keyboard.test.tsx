/**
 * Tests for `useComposerKeyboard`'s host-focus relay: a New Chat / File
 * menu request focuses the live composer textarea.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { useRef } from "react";
import { act, cleanup, render } from "@testing-library/react";

import {
  consumePendingComposerFocus,
  requestComposerFocus,
} from "@/domains/chat/composer-focus";
import { useComposerKeyboard } from "@/domains/chat/hooks/use-composer-keyboard";

function Harness() {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  useComposerKeyboard(inputRef);
  return <textarea ref={inputRef} />;
}

afterEach(() => {
  consumePendingComposerFocus();
  cleanup();
});

describe("useComposerKeyboard host focus", () => {
  test("focuses the composer textarea when a focus request fires", () => {
    const { container } = render(<Harness />);
    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();

    act(() => {
      requestComposerFocus();
    });
    expect(document.activeElement).toBe(textarea);
  });
});
