import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  getAnyProviderEnvVar,
  getLlmProviderEnvVar,
  getSearchProviderEnvVar,
  SEARCH_PROVIDER_ENV_VAR_NAMES,
} from "../provider-env-vars.js";

describe("getLlmProviderEnvVar", () => {
  test("returns ANTHROPIC_API_KEY for anthropic", () => {
    expect(getLlmProviderEnvVar("anthropic")).toBe("ANTHROPIC_API_KEY");
  });

  test("returns OPENAI_API_KEY for openai", () => {
    expect(getLlmProviderEnvVar("openai")).toBe("OPENAI_API_KEY");
  });

  test("returns GEMINI_API_KEY for gemini", () => {
    expect(getLlmProviderEnvVar("gemini")).toBe("GEMINI_API_KEY");
  });

  test("returns FIREWORKS_API_KEY for fireworks", () => {
    expect(getLlmProviderEnvVar("fireworks")).toBe("FIREWORKS_API_KEY");
  });

  test("returns OPENROUTER_API_KEY for openrouter", () => {
    expect(getLlmProviderEnvVar("openrouter")).toBe("OPENROUTER_API_KEY");
  });

  test("returns undefined for ollama (keyless provider)", () => {
    expect(getLlmProviderEnvVar("ollama")).toBeUndefined();
  });

  test("returns undefined for search providers (out of scope)", () => {
    expect(getLlmProviderEnvVar("brave")).toBeUndefined();
    expect(getLlmProviderEnvVar("perplexity")).toBeUndefined();
  });

  test("returns undefined for unknown provider", () => {
    expect(getLlmProviderEnvVar("unknown-provider")).toBeUndefined();
  });
});

describe("getSearchProviderEnvVar", () => {
  test("returns BRAVE_API_KEY for brave", () => {
    expect(getSearchProviderEnvVar("brave")).toBe("BRAVE_API_KEY");
  });

  test("returns PERPLEXITY_API_KEY for perplexity", () => {
    expect(getSearchProviderEnvVar("perplexity")).toBe("PERPLEXITY_API_KEY");
  });

  test("returns undefined for LLM providers (out of scope)", () => {
    expect(getSearchProviderEnvVar("anthropic")).toBeUndefined();
    expect(getSearchProviderEnvVar("openai")).toBeUndefined();
  });

  test("returns undefined for unknown provider", () => {
    expect(getSearchProviderEnvVar("unknown-provider")).toBeUndefined();
  });
});

describe("getAnyProviderEnvVar", () => {
  test("returns LLM env var for LLM providers", () => {
    expect(getAnyProviderEnvVar("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(getAnyProviderEnvVar("openai")).toBe("OPENAI_API_KEY");
  });

  test("returns search env var for search providers", () => {
    expect(getAnyProviderEnvVar("brave")).toBe("BRAVE_API_KEY");
    expect(getAnyProviderEnvVar("perplexity")).toBe("PERPLEXITY_API_KEY");
  });

  test("returns undefined for ollama (keyless LLM provider)", () => {
    expect(getAnyProviderEnvVar("ollama")).toBeUndefined();
  });

  test("returns undefined for unknown provider", () => {
    expect(getAnyProviderEnvVar("unknown")).toBeUndefined();
  });
});

describe("SEARCH_PROVIDER_ENV_VAR_NAMES parity with meta/provider-env-vars.json", () => {
  // The daemon inlines the search-provider env-var map rather than reading
  // meta/provider-env-vars.json at runtime (compiled binary, no reliable
  // repo-relative path). This parity check prevents drift: the inline map
  // must stay in sync with the canonical JSON file consumed by the macOS
  // client bundle and the CLI cloud-infra flows.
  test("inline map matches meta/provider-env-vars.json providers", () => {
    const repoRoot = join(process.cwd(), "..");
    const metaPath = join(repoRoot, "meta", "provider-env-vars.json");
    const raw = readFileSync(metaPath, "utf-8");
    const parsed = JSON.parse(raw) as {
      version: number;
      providers: Record<string, string>;
    };
    expect(SEARCH_PROVIDER_ENV_VAR_NAMES).toEqual(parsed.providers);
  });
});
