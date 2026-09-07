/**
 * Pins that hosted Qwen persists sliders without an identity rewrite,
 * while every other active profile still runs the rewrite turn.
 *
 * NOTE: `bun mock.module` can leak across files. Run this file singly:
 *   bun test src/domains/intelligence/identity-actions/apply-personality-update.test.ts
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const configGetMock = mock(
  async (): Promise<{
    data?: unknown;
    error?: unknown;
    response: { ok: boolean; status?: number };
  }> => ({
    response: { ok: true, status: 200 },
  }),
);
const runIdentityRewriteMock = mock(async () => true);
const buildPersonalityMessageMock = mock(() => "<system-message>rewrite</system-message>");

mock.module("@/generated/daemon/sdk.gen", () => ({
  configGet: configGetMock,
}));
mock.module("./run-identity-rewrite", () => ({
  runIdentityRewrite: runIdentityRewriteMock,
}));
mock.module("@/assistant/personality-rewrite", () => ({
  buildPersonalityMessage: buildPersonalityMessageMock,
}));
mock.module("@/i18n", () => ({
  t: () => "Updating personality",
}));

const { applyPersonalityUpdate } = await import("./apply-personality-update");

function configFor(provider: string, model: string) {
  return {
    data: {
      llm: {
        activeProfile: "main",
        profiles: { main: { provider, model } },
      },
    },
    response: { ok: true, status: 200 },
  };
}

beforeEach(() => {
  configGetMock.mockClear();
  runIdentityRewriteMock.mockClear();
  buildPersonalityMessageMock.mockClear();
});

describe("applyPersonalityUpdate", () => {
  test("skips the identity rewrite when the active profile is hosted Qwen", async () => {
    configGetMock.mockResolvedValueOnce(configFor("vellum", "qwen/qwen3-8b"));

    await expect(
      applyPersonalityUpdate({
        assistantId: "ast-1",
        values: { "companion-coworker": 0 },
      }),
    ).resolves.toBe(true);

    expect(runIdentityRewriteMock).not.toHaveBeenCalled();
    expect(buildPersonalityMessageMock).not.toHaveBeenCalled();
  });

  test("rewrites identity when the active profile is not hosted Qwen", async () => {
    configGetMock.mockResolvedValueOnce(configFor("anthropic", "claude-opus-4-8"));

    await expect(
      applyPersonalityUpdate({
        assistantId: "ast-1",
        values: { "companion-coworker": 70 },
        assistantName: "Ada",
      }),
    ).resolves.toBe(true);

    expect(buildPersonalityMessageMock).toHaveBeenCalledWith(
      { "companion-coworker": 70 },
      undefined,
      "Ada",
    );
    expect(runIdentityRewriteMock).toHaveBeenCalledTimes(1);
    expect(runIdentityRewriteMock.mock.calls[0]?.[0]).toMatchObject({
      assistantId: "ast-1",
      content: "<system-message>rewrite</system-message>",
      context: "identity_personality_update",
    });
  });

  test("rewrites when a vellum profile is not the hosted Qwen snapshot", async () => {
    configGetMock.mockResolvedValueOnce(configFor("vellum", "qwen/qwen3-32b"));

    await expect(
      applyPersonalityUpdate({
        assistantId: "ast-1",
        values: {},
      }),
    ).resolves.toBe(true);

    expect(runIdentityRewriteMock).toHaveBeenCalledTimes(1);
  });

  test("rewrites when no usable active profile is configured", async () => {
    configGetMock.mockResolvedValueOnce({
      data: { llm: { profiles: {} } },
      response: { ok: true, status: 200 },
    });

    await expect(
      applyPersonalityUpdate({
        assistantId: "ast-1",
        values: {},
      }),
    ).resolves.toBe(true);

    expect(runIdentityRewriteMock).toHaveBeenCalledTimes(1);
  });

  test("returns false without rewriting when config cannot be loaded", async () => {
    configGetMock.mockResolvedValueOnce({
      response: { ok: false, status: 500 },
    });

    await expect(
      applyPersonalityUpdate({
        assistantId: "ast-1",
        values: { "companion-coworker": 0 },
      }),
    ).resolves.toBe(false);

    expect(runIdentityRewriteMock).not.toHaveBeenCalled();
  });
});
