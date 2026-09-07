/**
 * Pins that hosted Qwen on a steering-capable assistant persists sliders
 * without an identity rewrite, while older assistants and every other
 * active profile still run the rewrite turn. Success is the sidecar write.
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
const buildPersonalityMessageMock = mock(
  () => "<system-message>rewrite</system-message>",
);
const savePersonalitySlidersMock = mock(async () => true);
const completeSliderValuesMock = mock((values: Record<string, number>) => ({
  "companion-coworker": 50,
  ...values,
}));
const supportsSteeringMock = mock(async () => true);

mock.module("@/generated/daemon/sdk.gen", () => ({
  configGet: configGetMock,
}));
mock.module("./run-identity-rewrite", () => ({
  runIdentityRewrite: runIdentityRewriteMock,
}));
mock.module("@/assistant/personality-rewrite", () => ({
  buildPersonalityMessage: buildPersonalityMessageMock,
}));
mock.module("@/assistant/personality-sliders", () => ({
  completeSliderValues: completeSliderValuesMock,
  savePersonalitySliders: savePersonalitySlidersMock,
}));
mock.module("@/lib/backwards-compat/hosted-qwen-personality-steering", () => ({
  assistantSupportsHostedQwenPersonalitySteering: supportsSteeringMock,
}));
mock.module("@/i18n", () => ({
  t: () => "Updating personality",
}));

const { applyPersonalityUpdate } = await import("./apply-personality-update");

function configFor(
  provider: string,
  model: string,
  status?: "active" | "disabled",
) {
  return {
    data: {
      llm: {
        activeProfile: "main",
        profiles: {
          main: {
            provider,
            model,
            ...(status ? { status } : {}),
          },
        },
      },
    },
    response: { ok: true, status: 200 },
  };
}

beforeEach(() => {
  configGetMock.mockClear();
  runIdentityRewriteMock.mockClear();
  buildPersonalityMessageMock.mockClear();
  savePersonalitySlidersMock.mockClear();
  completeSliderValuesMock.mockClear();
  supportsSteeringMock.mockClear();
  supportsSteeringMock.mockResolvedValue(true);
  savePersonalitySlidersMock.mockResolvedValue(true);
});

describe("applyPersonalityUpdate", () => {
  test("skips the identity rewrite when hosted Qwen can steer from the sidecar", async () => {
    configGetMock.mockResolvedValueOnce(configFor("vellum", "qwen/qwen3-8b"));

    await expect(
      applyPersonalityUpdate({
        assistantId: "ast-1",
        values: { "companion-coworker": 0 },
      }),
    ).resolves.toBe(true);

    expect(runIdentityRewriteMock).not.toHaveBeenCalled();
    expect(buildPersonalityMessageMock).not.toHaveBeenCalled();
    expect(savePersonalitySlidersMock).toHaveBeenCalledWith("ast-1", {
      "companion-coworker": 0,
    });
  });

  test("returns false when the hosted sidecar write fails", async () => {
    configGetMock.mockResolvedValueOnce(configFor("vellum", "qwen/qwen3-8b"));
    savePersonalitySlidersMock.mockResolvedValueOnce(false);

    await expect(
      applyPersonalityUpdate({
        assistantId: "ast-1",
        values: { "companion-coworker": 0 },
      }),
    ).resolves.toBe(false);

    expect(runIdentityRewriteMock).not.toHaveBeenCalled();
    expect(savePersonalitySlidersMock).toHaveBeenCalledTimes(1);
  });

  test("rewrites on hosted Qwen when the assistant predates sidecar steering", async () => {
    configGetMock.mockResolvedValueOnce(configFor("vellum", "qwen/qwen3-8b"));
    supportsSteeringMock.mockResolvedValueOnce(false);

    await expect(
      applyPersonalityUpdate({
        assistantId: "ast-1",
        values: { "companion-coworker": 0 },
      }),
    ).resolves.toBe(true);

    expect(runIdentityRewriteMock).toHaveBeenCalledTimes(1);
    expect(savePersonalitySlidersMock).toHaveBeenCalledTimes(1);
  });

  test("rewrites identity when the active profile is not hosted Qwen", async () => {
    configGetMock.mockResolvedValueOnce(
      configFor("anthropic", "claude-opus-4-8"),
    );

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
    expect(savePersonalitySlidersMock).toHaveBeenCalledTimes(1);
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

  test("rewrites when the active hosted Qwen profile is disabled", async () => {
    configGetMock.mockResolvedValueOnce(
      configFor("vellum", "qwen/qwen3-8b", "disabled"),
    );

    await expect(
      applyPersonalityUpdate({
        assistantId: "ast-1",
        values: {},
      }),
    ).resolves.toBe(true);

    expect(runIdentityRewriteMock).toHaveBeenCalledTimes(1);
    expect(supportsSteeringMock).not.toHaveBeenCalled();
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

  test("does not save sliders when the rewrite fails", async () => {
    configGetMock.mockResolvedValueOnce(
      configFor("anthropic", "claude-opus-4-8"),
    );
    runIdentityRewriteMock.mockResolvedValueOnce(false);

    await expect(
      applyPersonalityUpdate({
        assistantId: "ast-1",
        values: {},
      }),
    ).resolves.toBe(false);

    expect(savePersonalitySlidersMock).not.toHaveBeenCalled();
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
    expect(savePersonalitySlidersMock).not.toHaveBeenCalled();
  });
});
