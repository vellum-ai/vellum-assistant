/**
 * Tests for `ensureDefaultProvider` in `workspace/default-provider-ensure.ts`.
 *
 * `hasManagedProxyPrereqs` is mocked at module scope; `bun:test` isolates
 * `mock.module` per test file.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const proxyState = { prereqs: false };

mock.module("../providers/platform-proxy/context.js", () => ({
  hasManagedProxyPrereqs: async () => proxyState.prereqs,
}));

const { ensureDefaultProvider } =
  await import("../workspace/default-provider-ensure.js");
const { LLMSchema } = await import("../config/schemas/llm.js");

let workspaceDir: string;
let originalIsPlatform: string | undefined;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-default-provider-ensure-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
}

function writeConfig(data: Record<string, unknown>): void {
  writeFileSync(
    join(workspaceDir, "config.json"),
    JSON.stringify(data, null, 2) + "\n",
  );
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(workspaceDir, "config.json"), "utf-8"));
}

function llm(): Record<string, unknown> {
  return readConfig().llm as Record<string, unknown>;
}

beforeEach(() => {
  freshWorkspace();
  originalIsPlatform = process.env.IS_PLATFORM;
  delete process.env.IS_PLATFORM;
  proxyState.prereqs = false;
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
  if (originalIsPlatform === undefined) {
    delete process.env.IS_PLATFORM;
  } else {
    process.env.IS_PLATFORM = originalIsPlatform;
  }
});

describe("ensureDefaultProvider", () => {
  test("backfills from llm.default.provider", async () => {
    writeConfig({ llm: { default: { provider: "gemini" } } });

    await ensureDefaultProvider(workspaceDir);

    expect(llm().defaultProvider).toEqual({ provider: "gemini" });
  });

  test("backfills from custom-balanced provider", async () => {
    writeConfig({
      llm: {
        profiles: {
          "custom-balanced": { source: "user", provider: "openai" },
        },
      },
    });

    await ensureDefaultProvider(workspaceDir);

    expect(llm().defaultProvider).toEqual({ provider: "openai" });
  });

  test("uses custom-quality-optimized when custom-balanced lacks a provider", async () => {
    writeConfig({
      llm: {
        profiles: {
          "custom-balanced": { source: "user" },
          "custom-quality-optimized": { source: "user", provider: "fireworks" },
        },
      },
    });

    await ensureDefaultProvider(workspaceDir);

    expect(llm().defaultProvider).toEqual({ provider: "fireworks" });
  });

  test("IS_PLATFORM true resolves to vellum", async () => {
    process.env.IS_PLATFORM = "true";
    writeConfig({ llm: {} });

    await ensureDefaultProvider(workspaceDir);

    expect(llm().defaultProvider).toEqual({ provider: "vellum" });
  });

  test("IS_PLATFORM outranks a legacy provider signal", async () => {
    process.env.IS_PLATFORM = "1";
    writeConfig({ llm: { default: { provider: "anthropic" } } });

    await ensureDefaultProvider(workspaceDir);

    expect(llm().defaultProvider).toEqual({ provider: "vellum" });
  });

  test("a legacy BYOK signal outranks the login fallback off-platform", async () => {
    proxyState.prereqs = true;
    writeConfig({ llm: { default: { provider: "openai" } } });

    await ensureDefaultProvider(workspaceDir);

    expect(llm().defaultProvider).toEqual({ provider: "openai" });
  });

  test("hasManagedProxyPrereqs true resolves to vellum when off-platform", async () => {
    proxyState.prereqs = true;
    writeConfig({ llm: {} });

    await ensureDefaultProvider(workspaceDir);

    expect(llm().defaultProvider).toEqual({ provider: "vellum" });
  });

  test("falls back to anthropic when not on platform and not logged in", async () => {
    proxyState.prereqs = false;
    writeConfig({ llm: {} });

    await ensureDefaultProvider(workspaceDir);

    expect(llm().defaultProvider).toEqual({ provider: "anthropic" });
  });

  test("an invalid/non-catalog signal falls through to the matrix", async () => {
    proxyState.prereqs = false;
    writeConfig({ llm: { default: { provider: "minimax" } } });

    await ensureDefaultProvider(workspaceDir);

    expect(llm().defaultProvider).toEqual({ provider: "anthropic" });
  });

  test("never overwrites an existing defaultProvider value", async () => {
    process.env.IS_PLATFORM = "true";
    writeConfig({
      llm: {
        default: { provider: "gemini" },
        defaultProvider: { provider: "openai" },
      },
    });

    await ensureDefaultProvider(workspaceDir);

    expect(llm().defaultProvider).toEqual({ provider: "openai" });
  });

  test("is idempotent across repeated runs", async () => {
    writeConfig({ llm: { default: { provider: "gemini" } } });

    await ensureDefaultProvider(workspaceDir);
    const first = readFileSync(join(workspaceDir, "config.json"), "utf-8");
    await ensureDefaultProvider(workspaceDir);
    const second = readFileSync(join(workspaceDir, "config.json"), "utf-8");

    expect(second).toBe(first);
  });

  test("never writes connectionName", async () => {
    process.env.IS_PLATFORM = "true";
    writeConfig({ llm: {} });

    await ensureDefaultProvider(workspaceDir);

    expect(llm().defaultProvider).toEqual({ provider: "vellum" });
    expect(
      (llm().defaultProvider as Record<string, unknown>).connectionName,
    ).toBeUndefined();
  });

  test("the written config round-trips through LLMSchema.parse", async () => {
    writeConfig({ llm: {} });

    await ensureDefaultProvider(workspaceDir);

    const parsed = LLMSchema.parse(llm());
    expect(parsed.defaultProvider).toEqual({ provider: "anthropic" });
  });

  test("tolerates malformed config shapes without throwing", async () => {
    await expect(ensureDefaultProvider(workspaceDir)).resolves.toBeUndefined();
    expect(existsSync(join(workspaceDir, "config.json"))).toBe(false);

    writeConfig({ llm: "not-an-object" });
    await expect(ensureDefaultProvider(workspaceDir)).resolves.toBeUndefined();

    writeFileSync(join(workspaceDir, "config.json"), "not valid json {{{");
    await expect(ensureDefaultProvider(workspaceDir)).resolves.toBeUndefined();

    writeFileSync(join(workspaceDir, "config.json"), JSON.stringify([1, 2]));
    await expect(ensureDefaultProvider(workspaceDir)).resolves.toBeUndefined();
  });
});
