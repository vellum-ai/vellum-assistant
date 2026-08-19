import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import { type RefObject } from "react";
import type { HotkeyEvent } from "@vellumai/ipc-contract";

import {
  CTRL_PTT_ACTIVATOR,
  LS_PTT_ACTIVATION_KEY,
  serializeActivator,
} from "@/utils/ptt-activator";
import {
  PTT_HOLD_DELAY_MS,
  usePushToTalk,
} from "@/domains/chat/voice/use-push-to-talk";
import { setConfigurablePushToTalkActive } from "@/runtime/hotkey";
import { setLocalSetting } from "@/utils/local-settings";

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
  setConfigurablePushToTalkActive(false);
});

afterEach(() => {
  cleanup();
  delete window.vellum;
  document.body.innerHTML = "";
  localStorage.clear();
  setConfigurablePushToTalkActive(false);
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

  test("starts a multi-modifier chord immediately", () => {
    localStorage.setItem(
      LS_PTT_ACTIVATION_KEY,
      serializeActivator({
        kind: "modifierOnly",
        modifiers: ["control", "shift"],
      }),
    );
    const target = { start: mock(() => {}), stop: mock(() => {}) };
    renderPushToTalk(target);

    fireEvent.keyDown(window, { key: "Control", ctrlKey: true });
    fireEvent.keyDown(window, {
      key: "Shift",
      ctrlKey: true,
      shiftKey: true,
    });

    expect(target.start).toHaveBeenCalledTimes(1);
    fireEvent.keyUp(window, { key: "Shift", ctrlKey: true });
    expect(target.stop).toHaveBeenCalledTimes(1);
  });

  test("keeps a modifier active until both physical sides are released", async () => {
    localStorage.setItem(
      LS_PTT_ACTIVATION_KEY,
      serializeActivator(CTRL_PTT_ACTIVATOR),
    );
    const target = { start: mock(() => {}), stop: mock(() => {}) };
    renderPushToTalk(target);

    fireEvent.keyDown(window, {
      key: "Control",
      code: "ControlLeft",
      location: 1,
      ctrlKey: true,
    });
    fireEvent.keyDown(window, {
      key: "Control",
      code: "ControlRight",
      location: 2,
      ctrlKey: true,
    });
    await act(async () => {
      await wait(PTT_HOLD_DELAY_MS + 25);
    });
    expect(target.start).toHaveBeenCalledTimes(1);

    fireEvent.keyUp(window, {
      key: "Control",
      code: "ControlLeft",
      location: 1,
      ctrlKey: true,
    });
    expect(target.stop).not.toHaveBeenCalled();
    fireEvent.keyUp(window, {
      key: "Control",
      code: "ControlRight",
      location: 2,
      ctrlKey: false,
    });
    expect(target.stop).toHaveBeenCalledTimes(1);
  });

  test("stops an active hold when its binding changes", async () => {
    localStorage.setItem(
      LS_PTT_ACTIVATION_KEY,
      serializeActivator(CTRL_PTT_ACTIVATOR),
    );
    const target = { start: mock(() => {}), stop: mock(() => {}) };
    renderPushToTalk(target);

    fireEvent.keyDown(window, { key: "Control", ctrlKey: true });
    await act(async () => {
      await wait(PTT_HOLD_DELAY_MS + 25);
    });
    expect(target.start).toHaveBeenCalledTimes(1);

    setLocalSetting(
      LS_PTT_ACTIVATION_KEY,
      serializeActivator({ kind: "modifierOnly", modifiers: ["option"] }),
    );
    expect(target.stop).toHaveBeenCalledTimes(1);
  });

  test("keeps the legacy none value disabled", async () => {
    localStorage.setItem(LS_PTT_ACTIVATION_KEY, "none");
    const target = { start: mock(() => {}), stop: mock(() => {}) };
    renderPushToTalk(target);

    fireEvent.keyDown(window, { key: "Control", ctrlKey: true });
    await act(async () => {
      await wait(PTT_HOLD_DELAY_MS + 25);
    });

    expect(target.start).not.toHaveBeenCalled();
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

  test("uses native events without also listening to focused-window keys", async () => {
    let listener: ((event: HotkeyEvent) => void) | null = null;
    window.vellum = {
      platform: "electron",
      helper: {
        hotkey: {
          setPushToTalk: async () => ({ ok: true, enabled: true }),
          onEvent: (callback: (event: HotkeyEvent) => void) => {
            listener = callback;
            return () => {
              listener = null;
            };
          },
        },
      },
    } as unknown as typeof window.vellum;
    localStorage.setItem(
      LS_PTT_ACTIVATION_KEY,
      serializeActivator(CTRL_PTT_ACTIVATOR),
    );
    const target = { start: mock(() => {}), stop: mock(() => {}) };
    setConfigurablePushToTalkActive(true);
    renderPushToTalk(target);

    fireEvent.keyDown(window, { key: "Control", ctrlKey: true });
    await act(async () => {
      await wait(PTT_HOLD_DELAY_MS + 25);
    });
    expect(target.start).not.toHaveBeenCalled();

    act(() => listener?.({ kind: "pushToTalk", state: "down" }));
    expect(target.start).toHaveBeenCalledTimes(1);
    act(() => listener?.({ kind: "pushToTalk", state: "up" }));
    expect(target.stop).toHaveBeenCalledTimes(1);
  });

  test("keeps focused-window PTT when native registration is inactive", async () => {
    window.vellum = {
      platform: "electron",
      helper: {
        hotkey: {
          setPushToTalk: async () => ({ ok: false, reason: "unavailable" }),
          onEvent: () => () => undefined,
        },
      },
    } as unknown as typeof window.vellum;
    localStorage.setItem(
      LS_PTT_ACTIVATION_KEY,
      serializeActivator(CTRL_PTT_ACTIVATOR),
    );
    const target = { start: mock(() => {}), stop: mock(() => {}) };
    renderPushToTalk(target);

    fireEvent.keyDown(window, { key: "Control", ctrlKey: true });
    await act(async () => {
      await wait(PTT_HOLD_DELAY_MS + 25);
    });
    expect(target.start).toHaveBeenCalledTimes(1);
  });
});
