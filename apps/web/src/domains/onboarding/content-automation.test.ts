import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import {
  buildContentAutomationPreChatContext,
  CONTENT_AUTOMATION_INITIAL_MESSAGE,
  persistContentAutomationPreChatHandoff,
} from "@/domains/onboarding/content-automation.js";
import {
  INITIAL_MESSAGE_KEY,
  STORAGE_KEY,
} from "@/domains/onboarding/prechat.js";

class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) ?? null) : null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

const ORIGINAL_SESSION_STORAGE = Object.getOwnPropertyDescriptor(
  globalThis,
  "sessionStorage",
);

function installStorage(storage: Storage): void {
  Object.defineProperty(globalThis, "sessionStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
}

function uninstallStorage(): void {
  if (ORIGINAL_SESSION_STORAGE) {
    Object.defineProperty(globalThis, "sessionStorage", ORIGINAL_SESSION_STORAGE);
  } else {
    delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
  }
}

describe("content automation onboarding handoff", () => {
  beforeEach(() => {
    installStorage(new MemoryStorage());
  });

  afterAll(() => {
    uninstallStorage();
  });

  test("builds the cohort context used by the auto-skip path", () => {
    expect(buildContentAutomationPreChatContext()).toEqual({
      tools: [],
      tasks: ["writing", "research", "project-management"],
      tone: "grounded",
      googleConnected: false,
      cohort: "content-automation",
    });
  });

  test("persists both the pre-chat context and the chat auto-send key", () => {
    persistContentAutomationPreChatHandoff();

    const storage = (globalThis as { sessionStorage: Storage }).sessionStorage;
    expect(storage.getItem(INITIAL_MESSAGE_KEY)).toBe(
      CONTENT_AUTOMATION_INITIAL_MESSAGE,
    );
    expect(JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}")).toEqual(
      buildContentAutomationPreChatContext(),
    );
  });
});
