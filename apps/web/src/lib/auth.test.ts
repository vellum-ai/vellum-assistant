import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  getActiveOrganizationIdForRequests,
  getStoredOrganizationId,
  setActiveOrganizationIdForRequests,
} from "@/lib/organization/organization-state.js";

// Stub `@sentry/react` so `syncSentryUser` can be tested without
// booting the real SDK. The mock has to cover every named export this
// test file (and any module it pulls in transitively, like `auth.tsx`)
// reaches; missing methods turn into "not a function" TypeErrors at
// import time. Lives at the top of the file so `mock.module` registers
// before `@/lib/auth` is imported below.
const setUserMock = mock<(user: { id: string } | null) => void>(() => {});
mock.module("@sentry/react", () => ({
  setUser: setUserMock,
  captureException: () => {},
  captureMessage: () => {},
  addBreadcrumb: () => {},
  getClient: () => undefined,
  getCurrentScope: () => ({ setClient: () => {} }),
  init: () => {},
  captureRouterTransitionStart: () => {},
}));

import { syncOrganizationStateForUser, syncSentryUser } from "@/lib/auth.js";

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

describe("syncOrganizationStateForUser", () => {
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

  test("clears active organization state when user becomes unauthenticated", () => {
    setActiveOrganizationIdForRequests("org-123");
    expect(getStoredOrganizationId()).toBe("org-123");
    expect(getActiveOrganizationIdForRequests()).toBe("org-123");

    syncOrganizationStateForUser(
      {
        id: "user-1",
        username: "barry",
        email: "barry@example.com",
        is_staff: false,
      },
      null,
    );

    expect(getStoredOrganizationId()).toBeNull();
    expect(getActiveOrganizationIdForRequests()).toBeNull();
  });

  test("keeps active organization state during initial authenticated load", () => {
    setActiveOrganizationIdForRequests("org-123");

    syncOrganizationStateForUser(null, {
      id: "user-1",
      username: "barry",
      email: "barry@example.com",
      is_staff: false,
    });

    expect(getStoredOrganizationId()).toBe("org-123");
    expect(getActiveOrganizationIdForRequests()).toBe("org-123");
  });

  test("clears active organization state when authenticated user changes", () => {
    setActiveOrganizationIdForRequests("org-123");

    syncOrganizationStateForUser(
      {
        id: "user-1",
        username: "barry",
        email: "barry@example.com",
        is_staff: false,
      },
      {
        id: "user-2",
        username: "alice",
        email: "alice@example.com",
        is_staff: false,
      },
    );

    expect(getStoredOrganizationId()).toBeNull();
    expect(getActiveOrganizationIdForRequests()).toBeNull();
  });
});

describe("syncSentryUser", () => {
  beforeEach(() => {
    setUserMock.mockClear();
  });

  test("sets Sentry user id when an authenticated user is provided", () => {
    syncSentryUser({
      id: "user-1",
      username: "barry",
      email: "barry@example.com",
      is_staff: false,
    });

    expect(setUserMock).toHaveBeenCalledTimes(1);
    expect(setUserMock).toHaveBeenCalledWith({ id: "user-1" });
  });

  test("never forwards email or username to Sentry (privacy contract)", () => {
    syncSentryUser({
      id: "user-1",
      username: "barry",
      email: "barry@example.com",
      is_staff: true,
      first_name: "Barry",
      last_name: "Allen",
    });

    const arg = setUserMock.mock.calls[0]?.[0];
    expect(arg).toEqual({ id: "user-1" });
    // Explicitly assert the optional PII fields are absent so a future
    // refactor that "helpfully" adds them is caught here.
    expect(arg).not.toHaveProperty("email");
    expect(arg).not.toHaveProperty("username");
    expect(arg).not.toHaveProperty("ip_address");
  });

  test("does NOT fall back to email or username when id is absent (PII safety)", () => {
    // Defends the privacy contract against a tempting "improvement"
    // that reuses `getAuthSessionUserId()` (which does fall back to
    // email then username for org-state bookkeeping purposes). Doing
    // so here would write the email or username into Sentry as
    // `user.id`. The correct behavior when `id` is absent is to clear
    // the Sentry user — the event will simply report as anonymous.
    syncSentryUser({
      username: "barry",
      email: "barry@example.com",
      is_staff: false,
    });
    expect(setUserMock).toHaveBeenCalledWith(null);

    setUserMock.mockClear();

    syncSentryUser({
      username: "barry",
      is_staff: false,
    });
    expect(setUserMock).toHaveBeenCalledWith(null);
  });

  test("clears Sentry user on logout (null user)", () => {
    syncSentryUser(null);
    expect(setUserMock).toHaveBeenCalledTimes(1);
    expect(setUserMock).toHaveBeenCalledWith(null);
  });

  test("clears Sentry user when user has no identifying fields", () => {
    syncSentryUser({ is_staff: false });
    expect(setUserMock).toHaveBeenCalledWith(null);
  });
});
