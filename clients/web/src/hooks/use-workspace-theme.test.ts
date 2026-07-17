/**
 * Pins the read contract the workspace-theme hook leans on: an assistant
 * without the route (older, or rolled back from a themed version) 404s the
 * read, which resolves to `null` so a refetch overwrites the last-applied
 * theme and the hook clears the tokens. Every other failure throws so a
 * transient error keeps the last-good theme and retries.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

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

  test("throws on a non-404 failure so the query keeps the last-good theme", async () => {
    workspaceThemeGetMock.mockResolvedValueOnce({
      error: { detail: "boom" },
      response: { ok: false, status: 500 },
    });

    await expect(fetchWorkspaceTheme("assistant-1")).rejects.toThrow();
  });

  test("throws on a network failure with no response", async () => {
    workspaceThemeGetMock.mockResolvedValueOnce({ response: undefined });

    await expect(fetchWorkspaceTheme("assistant-1")).rejects.toThrow();
  });
});
