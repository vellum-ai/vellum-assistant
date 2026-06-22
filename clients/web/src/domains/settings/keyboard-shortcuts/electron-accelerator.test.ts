import { describe, expect, it } from "bun:test";

import type { ResolvedHotkey } from "@/runtime/hotkeys";

import { eventToAccelerator, findConflict } from "./electron-accelerator";

/** Minimal stand-in for a captured keydown — only the fields we read. */
const keydown = (
  init: Partial<
    Pick<
      KeyboardEvent,
      "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
    >
  >,
): KeyboardEvent =>
  ({
    code: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...init,
  }) as KeyboardEvent;

const hotkey = (
  key: string,
  accelerator: string,
  rebindable = true,
): ResolvedHotkey => ({
  key,
  label: key,
  scope: "menu",
  defaultAccelerator: accelerator,
  override: null,
  accelerator,
  rebindable,
});

describe("eventToAccelerator", () => {
  it("combines modifiers with a letter key in canonical order", () => {
    expect(
      eventToAccelerator(
        keydown({ code: "KeyN", metaKey: true, shiftKey: true }),
      ),
    ).toBe("CmdOrCtrl+Shift+N");
  });

  it("maps Command to CmdOrCtrl and the physical Control key to Control", () => {
    expect(eventToAccelerator(keydown({ code: "KeyK", metaKey: true }))).toBe(
      "CmdOrCtrl+K",
    );
    expect(eventToAccelerator(keydown({ code: "KeyK", ctrlKey: true }))).toBe(
      "Control+K",
    );
  });

  it("resolves arrows, digits, and punctuation from the physical code", () => {
    expect(eventToAccelerator(keydown({ code: "ArrowUp", metaKey: true }))).toBe(
      "CmdOrCtrl+Up",
    );
    expect(
      eventToAccelerator(keydown({ code: "Digit1", metaKey: true })),
    ).toBe("CmdOrCtrl+1");
    // Shift+/ stays the slash key rather than becoming "?".
    expect(
      eventToAccelerator(keydown({ code: "Slash", metaKey: true, shiftKey: true })),
    ).toBe("CmdOrCtrl+Shift+/");
    expect(
      eventToAccelerator(keydown({ code: "Backslash", metaKey: true })),
    ).toBe("CmdOrCtrl+\\");
  });

  it("returns null for a lone modifier press", () => {
    expect(eventToAccelerator(keydown({ code: "MetaLeft", metaKey: true }))).toBeNull();
  });

  it("returns null for an unmapped key", () => {
    expect(eventToAccelerator(keydown({ code: "Lang1", metaKey: true }))).toBeNull();
  });
});

describe("findConflict", () => {
  const catalog = [
    hotkey("newConversation", "CmdOrCtrl+N"),
    hotkey("home", "CmdOrCtrl+Shift+H"),
  ];

  it("finds another command bound to the same accelerator", () => {
    expect(findConflict(catalog, "home", "CmdOrCtrl+N")?.key).toBe(
      "newConversation",
    );
  });

  it("ignores the command being edited", () => {
    expect(findConflict(catalog, "newConversation", "CmdOrCtrl+N")).toBeNull();
  });

  it("treats a free accelerator as conflict-free", () => {
    expect(findConflict(catalog, "home", "CmdOrCtrl+J")).toBeNull();
  });

  it("never reports a conflict for a disabled binding", () => {
    expect(findConflict(catalog, "home", "")).toBeNull();
  });

  it("flags a collision with a reserved, non-rebindable command", () => {
    const withReserved = [...catalog, hotkey("find", "CmdOrCtrl+F", false)];
    const clash = findConflict(withReserved, "home", "CmdOrCtrl+F");
    expect(clash?.key).toBe("find");
    expect(clash?.rebindable).toBe(false);
  });
});
