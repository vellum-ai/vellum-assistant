import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";

import {
  ensureProviderApiKey,
  injectGatewayApiKey,
  promptSecret,
  readGatewayApiKey,
  type ProviderSecretFetch,
} from "../lib/provider-secrets.js";

interface RecordedFetchCall {
  url: string;
  init?: RequestInit;
  body: unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeFetch(responses: Response[]): {
  calls: RecordedFetchCall[];
  fetchImpl: ProviderSecretFetch;
} {
  const calls: RecordedFetchCall[] = [];
  const fetchImpl: ProviderSecretFetch = async (input, init) => {
    calls.push({
      url: String(input),
      init,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
    });
    const response = responses.shift();
    if (!response) {
      throw new Error("Unexpected fetch call.");
    }
    return response;
  };

  return { calls, fetchImpl };
}

class FakePromptInput extends EventEmitter {
  isTTY = true;
  isRaw = false;
  private paused = false;
  pauseCount = 0;
  rawModes: boolean[] = [];

  isPaused(): boolean {
    return this.paused;
  }

  resume(): this {
    this.paused = false;
    return this;
  }

  pause(): this {
    this.paused = true;
    this.pauseCount += 1;
    return this;
  }

  setRawMode(value: boolean): this {
    this.isRaw = value;
    this.rawModes.push(value);
    return this;
  }
}

describe("provider secret helpers", () => {
  test("reads provider keys from the api_key namespace", async () => {
    const { calls, fetchImpl } = makeFetch([jsonResponse({ found: true })]);

    await readGatewayApiKey(
      "http://127.0.0.1:3000/",
      "anthropic",
      "guardian-token",
      fetchImpl,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://127.0.0.1:3000/v1/secrets/read");
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.headers).toMatchObject({
      Authorization: "Bearer guardian-token",
      "Content-Type": "application/json",
    });
    expect(calls[0].body).toEqual({
      type: "api_key",
      name: "anthropic",
      reveal: false,
    });
  });

  test("explains a missing secret route as a wrong active assistant URL", async () => {
    const { fetchImpl } = makeFetch([
      jsonResponse(
        {
          error: {
            code: "not_found",
            message: "Not found",
            path: "/v1/secrets/read",
          },
        },
        404,
      ),
    ]);

    await expect(
      readGatewayApiKey(
        "https://platform.vellum.ai",
        "anthropic",
        undefined,
        fetchImpl,
      ),
    ).rejects.toThrow("does not expose /v1/secrets/read");
  });

  test("injects provider keys into the api_key namespace", async () => {
    const { calls, fetchImpl } = makeFetch([jsonResponse({ success: true })]);

    await injectGatewayApiKey(
      "http://127.0.0.1:3000",
      "openai",
      "test-provider-key",
      "guardian-token",
      fetchImpl,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://127.0.0.1:3000/v1/secrets");
    expect(calls[0].body).toEqual({
      type: "api_key",
      name: "openai",
      value: "test-provider-key",
    });
  });

  test("does not prompt or rewrite an existing provider key", async () => {
    const { calls, fetchImpl } = makeFetch([jsonResponse({ found: true })]);
    let prompted = false;

    const result = await ensureProviderApiKey({
      gatewayUrl: "http://127.0.0.1:3000",
      provider: "anthropic",
      env: { ANTHROPIC_API_KEY: "test-provider-key" },
      fetchImpl,
      prompt: async () => {
        prompted = true;
        return "unused";
      },
    });

    expect(result).toEqual({
      status: "already_configured",
      provider: "anthropic",
    });
    expect(prompted).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test("stores a provider key from the matching environment variable", async () => {
    const { calls, fetchImpl } = makeFetch([
      jsonResponse({ found: false }),
      jsonResponse({ success: true }),
    ]);

    const result = await ensureProviderApiKey({
      gatewayUrl: "http://127.0.0.1:3000",
      provider: "anthropic",
      env: { ANTHROPIC_API_KEY: " test-provider-key " },
      fetchImpl,
      stdinIsTTY: false,
    });

    expect(result).toEqual({
      status: "configured",
      provider: "anthropic",
      source: "env",
    });
    expect(calls).toHaveLength(2);
    expect(calls[1].body).toEqual({
      type: "api_key",
      name: "anthropic",
      value: "test-provider-key",
    });
  });

  test("prompts when no matching provider key is in the environment", async () => {
    const { calls, fetchImpl } = makeFetch([
      jsonResponse({ found: false }),
      jsonResponse({ success: true }),
    ]);
    let promptText = "";

    const result = await ensureProviderApiKey({
      gatewayUrl: "http://127.0.0.1:3000",
      provider: "openai",
      env: {},
      fetchImpl,
      prompt: async (prompt) => {
        promptText = prompt;
        return "test-openai-key";
      },
    });

    expect(result).toEqual({
      status: "configured",
      provider: "openai",
      source: "prompt",
    });
    expect(promptText).toContain("OpenAI");
    expect(promptText).toContain("OPENAI_API_KEY");
    expect(calls[1].body).toEqual({
      type: "api_key",
      name: "openai",
      value: "test-openai-key",
    });
  });

  test("pauses prompt input after reading a secret", async () => {
    const input = new FakePromptInput();
    let outputText = "";
    const output = {
      write: (text: string) => {
        outputText += text;
        return true;
      },
    };

    const resultPromise = promptSecret("Enter key: ", {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    });
    input.emit("data", Buffer.from("test-provider-key\n"));

    await expect(resultPromise).resolves.toBe("test-provider-key");
    expect(input.pauseCount).toBe(1);
    expect(input.listenerCount("data")).toBe(0);
    expect(input.rawModes).toEqual([true, false]);
    expect(outputText).toBe("Enter key: \n");
  });

  test("returns a missing-key result in non-interactive shells", async () => {
    const { calls, fetchImpl } = makeFetch([jsonResponse({ found: false })]);

    const result = await ensureProviderApiKey({
      gatewayUrl: "http://127.0.0.1:3000",
      provider: "anthropic",
      env: {},
      fetchImpl,
      stdinIsTTY: false,
    });

    expect(result).toEqual({
      status: "missing",
      provider: "anthropic",
      message:
        "Missing ANTHROPIC_API_KEY. Set it in the environment or run vellum setup from an interactive terminal.",
    });
    expect(calls).toHaveLength(1);
  });

  test("reports an unavailable credential store without prompting", async () => {
    const { calls, fetchImpl } = makeFetch([
      jsonResponse({ found: false, unreachable: true }),
    ]);
    let prompted = false;

    const result = await ensureProviderApiKey({
      gatewayUrl: "http://127.0.0.1:3000",
      provider: "anthropic",
      env: {},
      fetchImpl,
      prompt: async () => {
        prompted = true;
        return "unused";
      },
    });

    expect(result.status).toBe("failed");
    expect(prompted).toBe(false);
    expect(calls).toHaveLength(1);
  });
});
