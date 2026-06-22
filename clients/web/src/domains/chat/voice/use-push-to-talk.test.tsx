import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import { type RefObject } from "react";

import {
  CTRL_PTT_ACTIVATOR,
  LS_PTT_ACTIVATION_KEY,
  serializeActivator,
} from "@/utils/ptt-activator";
import {
  PTT_HOLD_DELAY_MS,
  usePushToTalk,
} from "@/domains/chat/voice/use-push-to-talk";

interface PushToTalkTarget {
  start: () => void;
  stop: () => void;
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function renderPushToTalk(target: PushToTalkTarget): void {
  const targetRef: RefObject<PushToTalkTarget | null> = { current: target };
  renderHook(() => usePushToTalk(targetRef, { enabled: true }));
}

function focusedTextarea(): HTMLTextAreaElement {
  const textarea = document.createElement("textarea");
  document.body.appendChild(textarea);
  textarea.focus();
  return textarea;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  localStorage.clear();
});

describe("usePushToTalk", () => {
  test("starts modifier-only PTT from a focused editable target", async () => {
    localStorage.setItem(
      LS_PTT_ACTIVATION_KEY,
      serializeActivator(CTRL_PTT_ACTIVATOR),
    );
    const target = { start: mock(() => {}), stop: mock(() => {}) };
    renderPushToTalk(target);
    const textarea = focusedTextarea();

    fireEvent.keyDown(textarea, { key: "Control", ctrlKey: true });
    expect(target.start).not.toHaveBeenCalled();

    await act(async () => {
      await wait(PTT_HOLD_DELAY_MS + 25);
    });

    expect(target.start).toHaveBeenCalledTimes(1);

    fireEvent.keyUp(textarea, { key: "Control" });
    expect(target.stop).toHaveBeenCalledTimes(1);
  });

  test("keeps key activators disabled inside editable targets", async () => {
    localStorage.setItem(
      LS_PTT_ACTIVATION_KEY,
      serializeActivator({ kind: "key", label: "K", modifiers: [] }),
    );
    const target = { start: mock(() => {}), stop: mock(() => {}) };
    renderPushToTalk(target);
    const textarea = focusedTextarea();

    fireEvent.keyDown(textarea, { key: "k" });

    await act(async () => {
      await wait(PTT_HOLD_DELAY_MS + 25);
    });

    expect(target.start).not.toHaveBeenCalled();
    expect(target.stop).not.toHaveBeenCalled();
  });

  test("cancels modifier-only PTT when a shortcut chord starts during hold", async () => {
    localStorage.setItem(
      LS_PTT_ACTIVATION_KEY,
      serializeActivator(CTRL_PTT_ACTIVATOR),
    );
    const target = { start: mock(() => {}), stop: mock(() => {}) };
    renderPushToTalk(target);
    const textarea = focusedTextarea();

    fireEvent.keyDown(textarea, { key: "Control", ctrlKey: true });
    fireEvent.keyDown(textarea, { key: "c", ctrlKey: true });

    await act(async () => {
      await wait(PTT_HOLD_DELAY_MS + 25);
    });

    expect(target.start).not.toHaveBeenCalled();
    expect(target.stop).not.toHaveBeenCalled();
  });
});
