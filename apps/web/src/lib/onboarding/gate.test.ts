/**
 * Tests for `resolveOnboardingRedirect`.
 *
 * Same localStorage/window shim pattern as `prefs.test.ts`: no
 * `@testing-library/react`, no DOM — just an in-memory Storage + window
 * shim so `readOnboardingCompleted()` can read/write a real-looking key.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

// ---------------------------------------------------------------------------
// Minimal in-memory Storage / Window shim
// ---------------------------------------------------------------------------

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
    this.store.set(key, String(value));
  }
}

const memoryStorage = new MemoryStorage();

const ORIGINAL_WINDOW_DESCRIPTOR = Object.getOwnPropertyDescriptor(
  globalThis,
  "window",
);
const ORIGINAL_LOCAL_STORAGE_DESCRIPTOR = Object.getOwnPropertyDescriptor(
  globalThis,
  "localStorage",
);

beforeAll(() => {
  Object.defineProperty(globalThis, "window", {
    value: { localStorage: memoryStorage },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "localStorage", {
    value: memoryStorage,
    configurable: true,
    writable: true,
  });
});

afterAll(() => {
  if (ORIGINAL_WINDOW_DESCRIPTOR) {
    Object.defineProperty(globalThis, "window", ORIGINAL_WINDOW_DESCRIPTOR);
  } else {
    delete (globalThis as { window?: unknown }).window;
  }
  if (ORIGINAL_LOCAL_STORAGE_DESCRIPTOR) {
    Object.defineProperty(
      globalThis,
      "localStorage",
      ORIGINAL_LOCAL_STORAGE_DESCRIPTOR,
    );
  } else {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

beforeEach(() => {
  memoryStorage.clear();
});

afterEach(() => {
  memoryStorage.clear();
});

// ---------------------------------------------------------------------------
// Subject under test
// ---------------------------------------------------------------------------

import { routes } from "@/lib/routes.js";

import { resolveOnboardingRedirect } from "@/lib/onboarding/gate.js";

// Key mirrored from `prefs.ts` — we intentionally don't import the private
// testing shim to keep the gate tests loosely coupled to internal layout.
const KEY_COMPLETED = "onboarding.completed";

describe("resolveOnboardingRedirect", () => {
  test("onboarding completed -> null (already onboarded)", () => {
    memoryStorage.setItem(KEY_COMPLETED, "true");
    expect(
      resolveOnboardingRedirect({
        intendedDestination: routes.assistant,
      }),
    ).toBeNull();
  });

  test("destination not /assistant -> null (only the assistant surface is gated)", () => {
    expect(
      resolveOnboardingRedirect({
        intendedDestination: routes.settings.root,
      }),
    ).toBeNull();
    expect(
      resolveOnboardingRedirect({
        intendedDestination: "/",
      }),
    ).toBeNull();
    expect(
      resolveOnboardingRedirect({
        intendedDestination: routes.account.root,
      }),
    ).toBeNull();
  });

  test("happy path: not completed, /assistant -> /onboarding/privacy", () => {
    expect(
      resolveOnboardingRedirect({
        intendedDestination: routes.assistant,
      }),
    ).toBe(routes.onboarding.privacy);
  });

  test("nested paths under /assistant are not gated (only the chat URL itself is gated)", () => {
    expect(
      resolveOnboardingRedirect({
        intendedDestination: `${routes.assistant}/conversation/abc`,
      }),
    ).toBeNull();
  });

  test("destination=routes.assistant with onboarding.completed='false' still gates", () => {
    memoryStorage.setItem(KEY_COMPLETED, "false");
    expect(
      resolveOnboardingRedirect({
        intendedDestination: routes.assistant,
      }),
    ).toBe(routes.onboarding.privacy);
  });

  test("absolute https URL with /assistant pathname is gated", () => {
    expect(
      resolveOnboardingRedirect({
        intendedDestination: `https://assistant.example.com${routes.assistant}`,
      }),
    ).toBe(routes.onboarding.privacy);
  });

  test("protocol-relative URL with /assistant pathname is gated", () => {
    expect(
      resolveOnboardingRedirect({
        intendedDestination: `//assistant.example.com${routes.assistant}`,
      }),
    ).toBe(routes.onboarding.privacy);
  });

  test("absolute URL whose pathname is not under /assistant is not gated", () => {
    expect(
      resolveOnboardingRedirect({
        intendedDestination: "https://assistant.example.com/settings",
      }),
    ).toBeNull();
  });

  test("malformed absolute-looking URL falls back to raw string and is not gated", () => {
    expect(
      resolveOnboardingRedirect({
        intendedDestination: "https://not a real url",
      }),
    ).toBeNull();
  });
});
