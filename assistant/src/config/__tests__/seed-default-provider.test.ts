import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

const WORKSPACE_DIR = process.env.VELLUM_WORKSPACE_DIR!;
const CONFIG_PATH = join(WORKSPACE_DIR, "config.json");

function ensureTestDir(): void {
  const dirs = [
    WORKSPACE_DIR,
    join(WORKSPACE_DIR, "data"),
    join(WORKSPACE_DIR, "data", "memory"),
    join(WORKSPACE_DIR, "data", "logs"),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

afterAll(() => {
  mock.restore();
});

import { invalidateConfigCache } from "../loader.js";
import { LLMSchema } from "../schemas/llm.js";
import {
  seedInferenceProfiles,
  type SeedInferenceProfilesOptions,
} from "../seed-inference-profiles.js";

type RawLLM = Record<string, unknown> & {
  defaultProvider?: { provider: string; connectionName?: string };
};

function writeConfig(obj: unknown): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(obj, null, 2) + "\n");
}

function readLLM(): RawLLM {
  return (JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as { llm: RawLLM })
    .llm;
}

function seed(
  config: Record<string, unknown>,
  options: SeedInferenceProfilesOptions,
): RawLLM {
  writeConfig(config);
  invalidateConfigCache();
  seedInferenceProfiles(options);
  invalidateConfigCache();
  return readLLM();
}

describe("seedInferenceProfiles / llm.defaultProvider", () => {
  beforeEach(() => {
    ensureTestDir();
    if (existsSync(CONFIG_PATH)) {
      rmSync(CONFIG_PATH, { force: true });
    }
    delete process.env.IS_PLATFORM;
    invalidateConfigCache();
  });

  afterEach(() => {
    delete process.env.IS_PLATFORM;
    invalidateConfigCache();
  });

  test("platform hatch writes vellum", () => {
    process.env.IS_PLATFORM = "true";
    const llm = seed(
      { llm: { default: { provider: "anthropic" } } },
      { isHatch: true },
    );
    expect(llm.defaultProvider).toEqual({ provider: "vellum" });
  });

  test("BYOK hatch with an anthropic key writes anthropic", () => {
    const llm = seed(
      { llm: { default: { provider: "anthropic" } } },
      { isHatch: true },
    );
    expect(llm.defaultProvider).toEqual({ provider: "anthropic" });
  });

  test("BYOK hatch with an openai key writes openai", () => {
    const llm = seed(
      { llm: { default: { provider: "openai" } } },
      { isHatch: true },
    );
    expect(llm.defaultProvider).toEqual({ provider: "openai" });
  });

  test("BYOK hatch with provider ollama falls back to anthropic", () => {
    const llm = seed(
      { llm: { default: { provider: "ollama" } } },
      { isHatch: true },
    );
    expect(llm.defaultProvider).toEqual({ provider: "anthropic" });
  });

  test("BYOK hatch with no provider entered falls back to anthropic", () => {
    const llm = seed({ llm: {} }, { isHatch: true });
    expect(llm.defaultProvider).toEqual({ provider: "anthropic" });
  });

  test("BYOK hatch that selected a managed connection writes vellum", () => {
    const llm = seed(
      {
        llm: {
          default: { provider: "anthropic" },
          activeProfile: "balanced",
        },
      },
      { isHatch: true, preserveActiveProfile: true },
    );
    expect(llm.defaultProvider).toEqual({ provider: "vellum" });
  });

  test("a pre-existing defaultProvider survives a platform hatch untouched", () => {
    process.env.IS_PLATFORM = "true";
    const llm = seed(
      {
        llm: {
          default: { provider: "anthropic" },
          defaultProvider: { provider: "openai" },
        },
      },
      { isHatch: true },
    );
    expect(llm.defaultProvider).toEqual({ provider: "openai" });
  });

  test("a pre-existing defaultProvider survives a BYOK hatch untouched", () => {
    const llm = seed(
      {
        llm: {
          default: { provider: "anthropic" },
          defaultProvider: { provider: "openai" },
        },
      },
      { isHatch: true },
    );
    expect(llm.defaultProvider).toEqual({ provider: "openai" });
  });

  test("a pre-existing defaultProvider survives a managed-connection hatch untouched", () => {
    const llm = seed(
      {
        llm: {
          default: { provider: "anthropic" },
          activeProfile: "balanced",
          defaultProvider: { provider: "openai" },
        },
      },
      { isHatch: true, preserveActiveProfile: true },
    );
    expect(llm.defaultProvider).toEqual({ provider: "openai" });
  });

  test("non-hatch boot writes nothing", () => {
    const llm = seed({ llm: { default: { provider: "anthropic" } } }, {});
    expect(llm.defaultProvider).toBeUndefined();
  });

  test("seeded config round-trips through LLMSchema.parse with the field intact", () => {
    const llm = seed(
      { llm: { default: { provider: "anthropic" } } },
      { isHatch: true },
    );
    const parsed = LLMSchema.parse(llm);
    expect(parsed.defaultProvider).toEqual({ provider: "anthropic" });
  });

  test("no connectionName is ever written", () => {
    process.env.IS_PLATFORM = "true";
    const platformLLM = seed(
      { llm: { default: { provider: "anthropic" } } },
      { isHatch: true },
    );
    expect(platformLLM.defaultProvider?.connectionName).toBeUndefined();

    delete process.env.IS_PLATFORM;
    const byokLLM = seed(
      { llm: { default: { provider: "openai" } } },
      { isHatch: true },
    );
    expect(byokLLM.defaultProvider?.connectionName).toBeUndefined();

    const fallbackLLM = seed({ llm: {} }, { isHatch: true });
    expect(fallbackLLM.defaultProvider?.connectionName).toBeUndefined();
  });
});
