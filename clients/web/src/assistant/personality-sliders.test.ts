/**
 * Pins the read contract the overview's Personality card leans on: a
 * genuinely missing sidecar (404) resolves `null` so the card can plot the
 * neutral radar, but every other failure throws so a transient read error
 * degrades to a no-stat card instead of an all-centered radar over saved dials.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const workspaceFileGetMock = mock(
  async (): Promise<{ data?: unknown; error?: unknown; response: unknown }> => ({
    response: { ok: true, status: 200 },
  }),
);
mock.module("@/generated/daemon/sdk.gen", () => ({
  workspaceFileGet: workspaceFileGetMock,
  workspaceWritePost: mock(async () => ({ response: { ok: true, status: 200 } })),
}));

const { fetchPersonalitySliders } = await import("./personality-sliders");

beforeEach(() => {
  workspaceFileGetMock.mockClear();
});

describe("fetchPersonalitySliders", () => {
  test("returns null when the sidecar was never persisted (404)", async () => {
    workspaceFileGetMock.mockResolvedValueOnce({
      response: { ok: false, status: 404 },
    });

    expect(await fetchPersonalitySliders("ast-1")).toBeNull();
  });

  test("returns the parsed values when the sidecar exists", async () => {
    workspaceFileGetMock.mockResolvedValueOnce({
      data: { content: JSON.stringify({ "playful-serious": 80 }) },
      response: { ok: true, status: 200 },
    });

    expect(await fetchPersonalitySliders("ast-1")).toEqual({
      "playful-serious": 80,
    });
  });

  test("throws on a non-OK response that is not a 404", async () => {
    workspaceFileGetMock.mockResolvedValueOnce({
      response: { ok: false, status: 500 },
    });

    await expect(fetchPersonalitySliders("ast-1")).rejects.toThrow();
  });

  test("throws when the sidecar content is malformed", async () => {
    workspaceFileGetMock.mockResolvedValueOnce({
      data: { content: JSON.stringify({ "playful-serious": "loud" }) },
      response: { ok: true, status: 200 },
    });

    await expect(fetchPersonalitySliders("ast-1")).rejects.toThrow();
  });
});
