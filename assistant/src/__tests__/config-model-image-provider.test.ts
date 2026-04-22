import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { invalidateConfigCache } from "../config/loader.js";
import {
  type ModelSetContext,
  setImageGenModel,
} from "../daemon/handlers/config-model.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKSPACE_DIR = process.env.VELLUM_WORKSPACE_DIR!;
const CONFIG_PATH = join(WORKSPACE_DIR, "config.json");

function ensureTestDir(): void {
  const dirs = [WORKSPACE_DIR, join(WORKSPACE_DIR, "data")];
  for (const dir of dirs) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

function writeConfig(obj: unknown): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(obj));
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}

function makeCtx(): ModelSetContext {
  return {
    conversations: new Map(),
    suppressConfigReload: false,
    setSuppressConfigReload: () => {},
    updateConfigFingerprint: () => {},
    debounceTimers: {
      // No-op scheduler: the test asserts the persisted config shape, not
      // the debounce behaviour. Firing the callback synchronously would
      // mutate state after the assertion; dropping it keeps the test
      // deterministic.
      schedule: (_key: string, _fn: () => void, _ms: number) => {},
    },
  };
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  ensureTestDir();
  writeConfig({});
  invalidateConfigCache();
});

afterEach(() => {
  try {
    writeConfig({});
    invalidateConfigCache();
  } catch {
    // best-effort cleanup
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("setImageGenModel — provider derived from model prefix", () => {
  test("gemini model writes provider=gemini", () => {
    setImageGenModel("gemini-3.1-flash-image-preview", makeCtx());

    const config = readConfig();
    const imageGen = (config.services as any)?.["image-generation"];
    expect(imageGen?.model).toBe("gemini-3.1-flash-image-preview");
    expect(imageGen?.provider).toBe("gemini");
  });

  test("gpt-image-2 writes provider=openai", () => {
    setImageGenModel("gpt-image-2", makeCtx());

    const config = readConfig();
    const imageGen = (config.services as any)?.["image-generation"];
    expect(imageGen?.model).toBe("gpt-image-2");
    expect(imageGen?.provider).toBe("openai");
  });

  test("dall-e-3 writes provider=openai", () => {
    setImageGenModel("dall-e-3", makeCtx());

    const config = readConfig();
    const imageGen = (config.services as any)?.["image-generation"];
    expect(imageGen?.model).toBe("dall-e-3");
    expect(imageGen?.provider).toBe("openai");
  });

  test("switching from gemini to openai flips provider in place", () => {
    setImageGenModel("gemini-3.1-flash-image-preview", makeCtx());
    let imageGen = (readConfig().services as any)?.["image-generation"];
    expect(imageGen?.provider).toBe("gemini");

    setImageGenModel("gpt-image-2", makeCtx());
    imageGen = (readConfig().services as any)?.["image-generation"];
    expect(imageGen?.model).toBe("gpt-image-2");
    expect(imageGen?.provider).toBe("openai");
  });
});
