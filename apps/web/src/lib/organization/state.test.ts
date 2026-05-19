import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  clearStoredOrganizationId,
  getActiveOrganizationIdForRequests,
  getStoredOrganizationId,
  resolveActiveOrganizationId,
  subscribeToActiveOrganizationIdForRequests,
  setActiveOrganizationIdForRequests,
  setStoredOrganizationId,
} from "@/lib/organization/organization-state.js";

class StorageShim {
  private readonly data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.data.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }

  clear(): void {
    this.data.clear();
  }

  get length(): number {
    return this.data.size;
  }
}

const originalSessionStorage = Object.getOwnPropertyDescriptor(
  globalThis,
  "sessionStorage",
);

describe("resolveActiveOrganizationId", () => {
  test("returns null for empty organizations", () => {
    expect(resolveActiveOrganizationId([], "org-1")).toBeNull();
  });

  test("returns stored org when it belongs to organizations list", () => {
    const organizations = [{ id: "org-1" }, { id: "org-2" }];
    expect(resolveActiveOrganizationId(organizations, "org-2")).toBe("org-2");
  });

  test("falls back to first org when stored org is not present", () => {
    const organizations = [{ id: "org-1" }, { id: "org-2" }];
    expect(resolveActiveOrganizationId(organizations, "org-3")).toBe("org-1");
  });
});

describe("organization request state", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: new StorageShim(),
    });
    setActiveOrganizationIdForRequests(null);
  });

  afterEach(() => {
    setActiveOrganizationIdForRequests(null);
    if (originalSessionStorage) {
      Object.defineProperty(globalThis, "sessionStorage", originalSessionStorage);
      return;
    }

    Reflect.deleteProperty(globalThis, "sessionStorage");
  });

  test("stores and clears persisted organization id", () => {
    setStoredOrganizationId("org-1");
    expect(getStoredOrganizationId()).toBe("org-1");

    clearStoredOrganizationId();
    expect(getStoredOrganizationId()).toBeNull();
  });

  test("setActiveOrganizationIdForRequests mirrors to session storage", () => {
    setActiveOrganizationIdForRequests("org-1");
    expect(getStoredOrganizationId()).toBe("org-1");

    setActiveOrganizationIdForRequests(null);
    expect(getStoredOrganizationId()).toBeNull();
  });

  test("request memory value wins over newer session storage values", () => {
    setActiveOrganizationIdForRequests("org-1");
    setStoredOrganizationId("org-2");

    expect(getActiveOrganizationIdForRequests()).toBe("org-1");
  });

  test("falls back to stored value when memory value is empty", () => {
    setStoredOrganizationId("org-3");

    expect(getActiveOrganizationIdForRequests()).toBe("org-3");
  });

  test("notifies subscribers when active organization request state changes", () => {
    let updateCount = 0;
    const unsubscribe = subscribeToActiveOrganizationIdForRequests(() => {
      updateCount += 1;
    });

    setActiveOrganizationIdForRequests("org-1");
    setActiveOrganizationIdForRequests(null);

    unsubscribe();
    setActiveOrganizationIdForRequests("org-2");

    expect(updateCount).toBe(2);
  });
});
