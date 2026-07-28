/**
 * Pins the read contract the workspace-theme hook leans on: an assistant
 * without the route (older, or rolled back from a themed version) 404s the
 * read, which resolves to `null` so a refetch overwrites the last-applied
 * theme and the hook clears the tokens. Every other HTTP failure throws a
 * status-carrying {@link ApiError} so the global retry predicate can honour the
 * no-retry-4xx policy, while a network error (no response) rethrows raw and
 * stays retryable.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { ApiError } from "@/utils/api-errors";
import { httpStatusFromError, shouldRetryQuery } from "@/utils/query-retry";
import type { WorkspaceTheme } from "@/domains/settings/utils/workspace-theme-tokens";

const workspaceThemeGetMock = mock(
  async (): Promise<{ data?: unknown; error?: unknown; response: unknown }> => ({
    data: { theme: null, source: "none", issues: [] },
    response: { ok: true, status: 200 },
  }),
);
mock.module("@/generated/daemon/sdk.gen", () => ({
  workspaceThemeGet: workspaceThemeGetMock,
}));
mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  workspaceThemeGetQueryKey: () => [{ _id: "workspaceThemeGet" }],
}));

const { fetchWorkspaceTheme } = await import("./use-workspace-theme");

const THEME: WorkspaceTheme = { version: 1, tokens: { accent: "#abcdef" } };

beforeEach(() => {
  workspaceThemeGetMock.mockClear();
});

describe("fetchWorkspaceTheme", () => {
  test("returns the theme from a 200 response", async () => {
    workspaceThemeGetMock.mockResolvedValueOnce({
      data: { theme: THEME, source: "workspace", issues: [] },
      response: { ok: true, status: 200 },
    });

    expect(await fetchWorkspaceTheme("assistant-1")).toEqual(THEME);
  });

  test("returns null when a 200 response carries no theme", async () => {
    expect(await fetchWorkspaceTheme("assistant-1")).toBeNull();
  });

  test("maps a 404 to null so a rolled-back assistant clears its theme", async () => {
    workspaceThemeGetMock.mockResolvedValueOnce({
      error: { detail: "Not found" },
      response: { ok: false, status: 404 },
    });

    expect(await fetchWorkspaceTheme("assistant-1")).toBeNull();
  });

  test("throws a status-carrying error on a non-404 failure so the query keeps the last-good theme", async () => {
    workspaceThemeGetMock.mockResolvedValueOnce({
      error: { detail: "boom" },
      response: { ok: false, status: 500 },
    });

    const err = await fetchWorkspaceTheme("assistant-1").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(httpStatusFromError(err)).toBe(500);
  });

  test("a rate-limited (429) failure throws an error the global retry predicate won't retry", async () => {
    workspaceThemeGetMock.mockResolvedValueOnce({
      error: { detail: "Too Many Requests" },
      response: { ok: false, status: 429 },
    });

    const err = await fetchWorkspaceTheme("assistant-1").catch((e) => e);
    expect(httpStatusFromError(err)).toBe(429);
    expect(shouldRetryQuery(0, err)).toBe(false);
  });

  test("rethrows a network failure (no response) as a retryable error", async () => {
    workspaceThemeGetMock.mockResolvedValueOnce({ response: undefined });

    const err = await fetchWorkspaceTheme("assistant-1").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    // No HTTP status → the global retry predicate treats it as transient.
    expect(httpStatusFromError(err)).toBeUndefined();
    expect(shouldRetryQuery(0, err)).toBe(true);
  });
});
