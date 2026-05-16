import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

/**
 * Guard test: prevent accidental reintroduction of OpenAI Chat Completions
 * calls in the OpenAI provider path.
 *
 * OpenAI inference uses the Responses API (`client.responses.stream()`).
 * The chat-completions transport (`chat.completions.create()`) is reserved
 * for OpenAI-compatible providers (OpenRouter, Fireworks, Ollama).
 *
 * These guards fail CI if:
 * 1. The Responses provider file contains `chat.completions.create(` calls.
 * 2. The adapter factory wires `openai` to anything other than
 *    `OpenAIResponsesProvider`. (Catalog-driven adapter construction lives
 *    in `inference/adapter-factory.ts`; `registry.ts` only orchestrates it.)
 * 3. A new file appears in `providers/openai/` that introduces
 *    `chat.completions.create(` calls.
 *
 * Focused test commands for the OpenAI Responses API migration surface:
 *
 *   # This guard test
 *   bun test src/__tests__/openai-responses-cutover-guard.test.ts
 *
 *   # OpenAI provider tests (responses + chat-completions)
 *   bun test src/__tests__/openai-provider.test.ts
 *   bun test src/__tests__/openai-responses-provider.test.ts
 *
 *   # LLM context normalization (transport-agnostic message handling)
 *   bun test src/__tests__/llm-context-normalization.test.ts
 *
 *   # Provider registry and managed proxy integration
 *   bun test src/__tests__/registry.test.ts
 *   bun test src/__tests__/provider-managed-proxy-integration.test.ts
 *
 *   # Web search guard (allowlist includes both provider files)
 *   bun test src/__tests__/conversation-history-web-search.test.ts
 */

const PROVIDERS_DIR = join(import.meta.dir, "..", "providers");
const OPENAI_PROVIDERS_DIR = join(PROVIDERS_DIR, "openai");
const ADAPTER_FACTORY_PATH = join(
  PROVIDERS_DIR,
  "inference",
  "adapter-factory.ts",
);

describe("OpenAI Responses API cutover guard", () => {
  test("responses-provider.ts does not contain chat.completions.create() calls", () => {
    const source = readFileSync(
      join(OPENAI_PROVIDERS_DIR, "responses-provider.ts"),
      "utf-8",
    );

    const hasChatCompletions = source.includes("chat.completions.create(");

    expect(
      hasChatCompletions,
      [
        "responses-provider.ts must NOT call chat.completions.create().",
        "OpenAI inference uses the Responses API (client.responses.stream()).",
        "If you need chat completions, use chat-completions-provider.ts instead.",
      ].join("\n"),
    ).toBe(false);
  });

  test("adapter-factory.ts wires the 'openai' provider to OpenAIResponsesProvider", () => {
    // Catalog-driven adapter construction lives in `adapter-factory.ts`.
    // `registry.ts` only orchestrates and wraps the adapter; the only place
    // that names a provider class for the "openai" id is the factory table.
    const source = readFileSync(ADAPTER_FACTORY_PATH, "utf-8");

    // The factory must import OpenAIResponsesProvider.
    expect(
      source.includes("OpenAIResponsesProvider"),
      "adapter-factory.ts must import OpenAIResponsesProvider for the openai provider.",
    ).toBe(true);

    // The factory must instantiate OpenAIResponsesProvider.
    const hasResponsesInstantiation = source.includes(
      "new OpenAIResponsesProvider(",
    );
    expect(
      hasResponsesInstantiation,
      [
        "adapter-factory.ts must instantiate OpenAIResponsesProvider for the 'openai' provider.",
        "OpenAI inference uses the Responses API, not chat completions.",
      ].join("\n"),
    ).toBe(true);

    // The factory must NOT instantiate OpenAIChatCompletionsProvider or
    // OpenAIProvider (the backward-compatible alias) inside the `openai:`
    // factory entry. Other entries (e.g. `openai-compatible:`) may legitimately
    // use OpenAIChatCompletionsProvider since that's the OpenAI Chat Completions
    // transport for third-party endpoints.
    const openaiEntryRegion =
      /(?:^|\s)openai\s*:\s*\([^)]*\)\s*=>\s*[\s\S]{0,400}?(?=\}\s*,\s*[a-z-]+\s*:|\}\s*;)/m.exec(
        source,
      )?.[0] ?? "";
    const chatCompletionsInstantiationsInOpenAi = [
      ...openaiEntryRegion.matchAll(
        /new\s+OpenAIChatCompletionsProvider\s*\(/g,
      ),
      ...openaiEntryRegion.matchAll(/new\s+OpenAIProvider\s*\(/g),
    ];
    expect(
      chatCompletionsInstantiationsInOpenAi.length,
      [
        "ADAPTER_FACTORIES['openai'] must NOT instantiate",
        "OpenAIChatCompletionsProvider or OpenAIProvider (legacy alias).",
        "Use OpenAIResponsesProvider for openai.",
      ].join("\n"),
    ).toBe(0);

    // The factory's "openai" entry must specifically map to OpenAIResponsesProvider.
    // Match `openai:` followed (within ~400 chars) by `new OpenAIResponsesProvider(`
    // to confirm wiring at the entry level, not just an unrelated reference.
    const openaiEntryWiring =
      /openai\s*:\s*\([^)]*\)\s*=>\s*[\s\S]{0,400}?new\s+OpenAIResponsesProvider\s*\(/;
    expect(
      openaiEntryWiring.test(source),
      [
        "adapter-factory.ts ADAPTER_FACTORIES['openai'] entry must construct",
        "OpenAIResponsesProvider. If the factory shape changed, update this guard.",
      ].join("\n"),
    ).toBe(true);
  });

  test("no files in providers/openai/ introduce chat.completions.create() calls", () => {
    // The chat-completions-provider.ts is the only file allowed to use
    // chat.completions.create() — it's the dedicated chat-completions transport.
    const ALLOWED_FILES = new Set(["chat-completions-provider.ts"]);

    const files = readdirSync(OPENAI_PROVIDERS_DIR).filter(
      (f) =>
        f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"),
    );

    const violations: string[] = [];
    for (const file of files) {
      if (ALLOWED_FILES.has(file)) continue;
      const source = readFileSync(join(OPENAI_PROVIDERS_DIR, file), "utf-8");
      if (source.includes("chat.completions.create(")) {
        violations.push(file);
      }
    }

    if (violations.length > 0) {
      const message = [
        "Found chat.completions.create() calls in OpenAI provider files that",
        "should not use the chat completions transport:",
        "",
        "Violations:",
        ...violations.map((f) => `  - providers/openai/${f}`),
        "",
        "OpenAI inference uses the Responses API. Only",
        "chat-completions-provider.ts may call chat.completions.create().",
      ].join("\n");
      expect(violations, message).toEqual([]);
    }
  });

  test("no production files outside providers/openai/ call chat.completions.create() for the openai provider path", () => {
    // Broader scan: ensure no other production file accidentally calls
    // chat.completions.create in a context that would affect the openai
    // provider path. This catches cases where someone might add a direct
    // OpenAI SDK call outside the provider directory.
    let grepOutput = "";
    try {
      grepOutput = execSync(
        `git grep -l "chat\\.completions\\.create(" -- 'assistant/src/**/*.ts'`,
        { encoding: "utf-8", cwd: process.cwd() + "/.." },
      ).trim();
    } catch (err) {
      // Exit code 1 means no matches
      if ((err as { status?: number }).status === 1) {
        return;
      }
      throw err;
    }

    // Allowed: chat-completions-provider.ts (the dedicated transport) and test files
    const ALLOWED_PATHS = new Set([
      "assistant/src/providers/openai/chat-completions-provider.ts",
    ]);

    const files = grepOutput
      .split("\n")
      .filter((f) => f.length > 0)
      .filter((f) => !f.includes("/__tests__/"))
      .filter((f) => !f.endsWith(".test.ts"));

    const violations = files.filter((f) => !ALLOWED_PATHS.has(f));

    if (violations.length > 0) {
      const message = [
        "Found chat.completions.create() calls in production files outside the",
        "allowed chat-completions transport:",
        "",
        "Violations:",
        ...violations.map((f) => `  - ${f}`),
        "",
        "OpenAI inference uses the Responses API. Direct chat.completions.create()",
        "calls should only exist in chat-completions-provider.ts.",
        "If this is a different provider (OpenRouter, Fireworks, etc.), add it to",
        "ALLOWED_PATHS in this guard test.",
      ].join("\n");
      expect(violations, message).toEqual([]);
    }
  });
});
