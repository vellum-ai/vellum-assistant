import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkProviderApiKey } from "../lib/api-key-check.js";

const PROVIDER_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "OLLAMA_API_KEY",
] as const;

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "api-key-check-test-"));
  mkdirSync(join(testDir, ".vellum"), { recursive: true });
  // Clear any provider keys from the process environment.
  for (const key of PROVIDER_KEYS) {
    delete process.env[key];
  }
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  for (const key of PROVIDER_KEYS) {
    delete process.env[key];
  }
});

describe("checkProviderApiKey", () => {
  test("returns hasKey:false when no .env file and no process env", () => {
    const result = checkProviderApiKey(testDir);
    expect(result.hasKey).toBe(false);
    expect(result.envPath).toBe(join(testDir, ".vellum", ".env"));
  });

  test("returns hasKey:false when .env file has placeholder value", () => {
    writeFileSync(
      join(testDir, ".vellum", ".env"),
      "ANTHROPIC_API_KEY=sk-ant-...\nOPENAI_API_KEY=sk-...\n",
    );
    const result = checkProviderApiKey(testDir);
    expect(result.hasKey).toBe(false);
  });

  test("returns hasKey:false when .env file has empty value", () => {
    writeFileSync(join(testDir, ".vellum", ".env"), "ANTHROPIC_API_KEY=\n");
    const result = checkProviderApiKey(testDir);
    expect(result.hasKey).toBe(false);
  });

  test("returns hasKey:true when .env file has a real Anthropic key", () => {
    writeFileSync(
      join(testDir, ".vellum", ".env"),
      "ANTHROPIC_API_KEY=sk-ant-api03-realkey123\n",
    );
    const result = checkProviderApiKey(testDir);
    expect(result.hasKey).toBe(true);
  });

  test("returns hasKey:true when .env file has a real OpenAI key", () => {
    writeFileSync(
      join(testDir, ".vellum", ".env"),
      "OPENAI_API_KEY=sk-proj-realkey123\n",
    );
    const result = checkProviderApiKey(testDir);
    expect(result.hasKey).toBe(true);
  });

  test("returns hasKey:true when process.env has a real key (no .env file)", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-realkey123";
    const result = checkProviderApiKey(testDir);
    expect(result.hasKey).toBe(true);
  });

  test("process.env takes priority over .env file placeholder", () => {
    writeFileSync(
      join(testDir, ".vellum", ".env"),
      "ANTHROPIC_API_KEY=sk-ant-...\n",
    );
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-realkey123";
    const result = checkProviderApiKey(testDir);
    expect(result.hasKey).toBe(true);
  });

  test("ignores comment lines and blank lines in .env file", () => {
    writeFileSync(
      join(testDir, ".vellum", ".env"),
      "# AI Provider API Keys\n\nANTHROPIC_API_KEY=sk-ant-api03-realkey123\n",
    );
    const result = checkProviderApiKey(testDir);
    expect(result.hasKey).toBe(true);
  });

  test("returns correct envPath even when .env file does not exist", () => {
    const result = checkProviderApiKey(testDir);
    expect(result.envPath).toBe(join(testDir, ".vellum", ".env"));
  });
});
