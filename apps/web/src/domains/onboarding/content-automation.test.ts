import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import {
  buildContentAutomationPreChatContext,
  CONTENT_AUTOMATION_INITIAL_MESSAGE,
  persistContentAutomationPreChatHandoff,
} from "@/domains/onboarding/content-automation";
import { STORAGE_KEY } from "@/domains/onboarding/prechat";

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

  test("builds the cohort context with initialMessage", () => {
    const context = buildContentAutomationPreChatContext();
    expect(context).toEqual({
      tools: [],
      tasks: ["writing", "research", "project-management"],
      tone: "grounded",
      googleConnected: false,
      cohort: "content-automation",
      initialMessage: CONTENT_AUTOMATION_INITIAL_MESSAGE,
    });
  });

  test("persists context (including initialMessage) to a single storage key", () => {
    persistContentAutomationPreChatHandoff();

    const storage = (globalThis as { sessionStorage: Storage }).sessionStorage;
    const persisted = JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}");
    expect(persisted).toEqual(buildContentAutomationPreChatContext());
    expect(persisted.initialMessage).toBe(CONTENT_AUTOMATION_INITIAL_MESSAGE);
  });
});
