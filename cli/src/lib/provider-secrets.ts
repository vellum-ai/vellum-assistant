import { spawnSync } from "node:child_process";

import { LLM_PROVIDER_ENV_VAR_NAMES } from "../shared/provider-env-vars.js";

export type LlmProviderId = keyof typeof LLM_PROVIDER_ENV_VAR_NAMES;

export type ProviderApiKeySource = "env" | "prompt";
export type ProviderSecretFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

export type EnsureProviderApiKeyResult =
  | {
      status: "already_configured";
      provider: LlmProviderId;
    }
  | {
      status: "configured";
      provider: LlmProviderId;
      source: ProviderApiKeySource;
    }
  | {
      status: "missing";
      provider: LlmProviderId;
      message: string;
    }
  | {
      status: "failed";
      provider: LlmProviderId;
      message: string;
    }
  | {
      status: "skipped";
      message: string;
    };

export interface EnsureProviderApiKeyOptions {
  gatewayUrl: string;
  provider: string | null;
  bearerToken?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: ProviderSecretFetch;
  prompt?: (prompt: string) => Promise<string>;
  stdinIsTTY?: boolean;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

export interface GatewayApiKeyReadResult {
  found: boolean;
  unreachable: boolean;
}

export interface HatchProviderApiKeyOptions {
  gatewayUrl: string;
  provider: LlmProviderId | null;
  bearerToken?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: ProviderSecretFetch;
  log?: (message: string) => void;
  prompt?: (prompt: string) => Promise<string>;
  stdinIsTTY?: boolean;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

const PROVIDER_LABELS: Record<LlmProviderId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Gemini",
  fireworks: "Fireworks",
  openrouter: "OpenRouter",
  "vercel-ai-gateway": "Vercel AI Gateway",
  minimax: "MiniMax",
  atlascloud: "Atlas Cloud",
  together: "Together AI",
  baseten: "Baseten",
};

export function formatProviderName(provider: LlmProviderId): string {
  return PROVIDER_LABELS[provider];
}

export function isSupportedLlmProvider(
  provider: string,
): provider is LlmProviderId {
  return Object.hasOwn(LLM_PROVIDER_ENV_VAR_NAMES, provider);
}

export function resolveHatchProvider(
  configValues: Record<string, string | undefined>,
): LlmProviderId | null {
  const provider = (
    resolveConfiguredMainAgentProvider(configValues) || "anthropic"
  ).toLowerCase();

  if (provider === "ollama") {
    return null;
  }

  if (!isSupportedLlmProvider(provider)) {
    throw new Error(
      `Provider '${provider}' does not have a supported API-key setup flow.`,
    );
  }

  return provider;
}

function resolveConfiguredMainAgentProvider(
  configValues: Record<string, string | undefined>,
): string | undefined {
  // Fresh hatches seed the active custom profile from llm.default and then
  // that active profile wins over static mainAgent call-site defaults. Match
  // that startup behavior so hatch prompts for the provider the assistant will
  // actually use on first chat.
  return (
    resolveProfileProvider(
      configValues,
      readConfigValue(configValues, "llm.activeProfile"),
    ) ??
    resolveFragmentProvider(configValues, "llm.default") ??
    resolveFragmentProvider(configValues, "llm.callSites.mainAgent") ??
    resolveProfileProvider(
      configValues,
      readConfigValue(configValues, "llm.callSites.mainAgent.profile"),
    )
  );
}

function resolveProfileProvider(
  configValues: Record<string, string | undefined>,
  profileName: string | undefined,
): string | undefined {
  if (!profileName) return undefined;
  return resolveFragmentProvider(configValues, `llm.profiles.${profileName}`);
}

function resolveFragmentProvider(
  configValues: Record<string, string | undefined>,
  prefix: string,
): string | undefined {
  const provider = readConfigValue(configValues, `${prefix}.provider`);
  if (provider) return provider;

  const model = readConfigValue(configValues, `${prefix}.model`);
  return model ? inferProviderFromModel(model) : undefined;
}

function readConfigValue(
  configValues: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const value = configValues[key]?.trim();
  return value && value.length > 0 ? value : undefined;
}

/**
 * Infer the provider a bare model ID implies, mirroring the assistant
 * resolver's `getCatalogProviderForModel`: an ID listed by multiple catalog
 * providers resolves to the FIRST one in catalog order. Vendor prefixes unique
 * to one provider map to it; shared gateway IDs (e.g. `anthropic/*`) fall
 * through to openrouter, the earlier catalog entry. Drift guard:
 * `cli/src/__tests__/provider-inference-parity.test.ts`. Exported for tests.
 */
export function inferProviderFromModel(model: string): string | undefined {
  if (model.startsWith("claude-")) {
    return "anthropic";
  }
  if (model.startsWith("gpt-")) {
    return "openai";
  }
  if (model.startsWith("gemini-")) {
    return "gemini";
  }
  if (model.startsWith("accounts/fireworks/models/")) {
    return "fireworks";
  }
  if (model.startsWith("openai/gpt-5.6")) {
    // Listed by OpenRouter (#37856), the earlier catalog entry; the Vercel
    // AI Gateway does not carry these IDs.
    return "openrouter";
  }
  if (model.startsWith("openai/") || model.startsWith("xai/")) {
    return "vercel-ai-gateway";
  }
  if (model.startsWith("MiniMaxAI/")) {
    return "together";
  }
  if (model.startsWith("deepseek-ai/")) {
    return "atlascloud";
  }
  if (model.startsWith("thinkingmachines/")) {
    return "baseten";
  }
  if (model.includes("/")) {
    return "openrouter";
  }
  if (model === "llama3.2" || model === "mistral") {
    return "ollama";
  }
  return undefined;
}

function gatewayUrlWithPath(gatewayUrl: string, path: string): string {
  return `${gatewayUrl.replace(/\/+$/, "")}${path}`;
}

function secretHeaders(bearerToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }
  return headers;
}

async function parseErrorMessage(response: Response): Promise<string> {
  let text = "";
  try {
    text = await response.text();
  } catch {
    // Fall through to status text.
  }

  try {
    const body = JSON.parse(text) as {
      error?: unknown;
    };
    const message = extractErrorMessage(body.error);
    if (message) return message;
  } catch {
    // Fall back to raw text below.
  }

  if (text.trim().length > 0) {
    return text.trim();
  }

  return response.statusText || `HTTP ${response.status}`;
}

function extractErrorMessage(error: unknown): string | null {
  if (typeof error === "string" && error.trim().length > 0) {
    return error.trim();
  }
  if (!error || typeof error !== "object") {
    return null;
  }

  const maybeMessage = (error as { message?: unknown }).message;
  if (typeof maybeMessage === "string" && maybeMessage.trim().length > 0) {
    return maybeMessage.trim();
  }

  return null;
}

export async function readGatewayApiKey(
  gatewayUrl: string,
  provider: LlmProviderId,
  bearerToken?: string,
  fetchImpl: ProviderSecretFetch = fetch,
): Promise<GatewayApiKeyReadResult> {
  const response = await fetchImpl(
    gatewayUrlWithPath(gatewayUrl, "/v1/secrets/read"),
    {
      method: "POST",
      headers: secretHeaders(bearerToken),
      body: JSON.stringify({
        type: "api_key",
        name: provider,
        reveal: false,
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!response.ok) {
    const message = await parseErrorMessage(response);
    if (response.status === 404) {
      throw new Error(
        `Active assistant at ${gatewayUrl} does not expose /v1/secrets/read (${message}). Run \`vellum ps\` to confirm the active assistant, then select a self-hosted assistant with \`vellum use <assistant>\` or wake a current assistant before running setup.`,
      );
    }
    throw new Error(
      `Failed to check ${formatProviderName(provider)} API key: ${message}`,
    );
  }

  const body = (await response.json()) as {
    found?: unknown;
    unreachable?: unknown;
  };
  return {
    found: body.found === true,
    unreachable: body.unreachable === true,
  };
}

export async function injectGatewayApiKey(
  gatewayUrl: string,
  provider: LlmProviderId,
  value: string,
  bearerToken?: string,
  fetchImpl: ProviderSecretFetch = fetch,
): Promise<void> {
  const response = await fetchImpl(
    gatewayUrlWithPath(gatewayUrl, "/v1/secrets"),
    {
      method: "POST",
      headers: secretHeaders(bearerToken),
      body: JSON.stringify({
        type: "api_key",
        name: provider,
        value,
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!response.ok) {
    const message = await parseErrorMessage(response);
    throw new Error(
      `Failed to store ${formatProviderName(provider)} API key: ${message}`,
    );
  }

  const body = (await response.json().catch(() => ({}))) as {
    success?: unknown;
    error?: unknown;
  };
  if (body.success === false) {
    const message =
      typeof body.error === "string" && body.error.trim().length > 0
        ? body.error
        : "Assistant rejected the API key.";
    throw new Error(message);
  }
}

export async function promptSecret(
  prompt: string,
  streams: {
    input?: NodeJS.ReadStream;
    output?: NodeJS.WriteStream;
  } = {},
): Promise<string> {
  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stdout;

  const restoreEcho = disableTerminalEcho(input);
  output.write(prompt);

  return new Promise((resolve, reject) => {
    const wasRaw = input.isRaw;
    if (input.isTTY) {
      input.setRawMode(true);
    }
    input.resume();

    let value = "";

    const cleanup = (): void => {
      input.removeListener("data", onData);
      if (input.isTTY) {
        input.setRawMode(wasRaw ?? false);
      }
      restoreEcho();
      input.pause();
    };

    const finish = (): void => {
      cleanup();
      output.write("\n");
      resolve(value);
    };

    const cancel = (): void => {
      cleanup();
      output.write("\n");
      reject(new Error("Input cancelled."));
    };

    const onData = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes[0] === 27) {
        return;
      }

      for (const byte of bytes) {
        if (byte === 3) {
          cancel();
          return;
        }
        if (byte === 10 || byte === 13) {
          finish();
          return;
        }
        if (byte === 8 || byte === 127) {
          value = value.slice(0, -1);
          continue;
        }
        if (byte >= 32 && byte <= 126) {
          value += String.fromCharCode(byte);
        }
      }
    };

    input.on("data", onData);
  });
}

function disableTerminalEcho(input: NodeJS.ReadStream): () => void {
  if (input !== process.stdin || !input.isTTY || process.platform === "win32") {
    return () => {};
  }

  const currentState = spawnSync("stty", ["-g"], {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "ignore"],
  });
  const state = currentState.stdout.trim();
  if (currentState.status !== 0 || state.length === 0) {
    return () => {};
  }

  const disabled = spawnSync("stty", ["-echo"], {
    stdio: ["inherit", "ignore", "ignore"],
  });
  if (disabled.status !== 0) {
    return () => {};
  }

  let restored = false;
  return () => {
    if (restored) {
      return;
    }
    restored = true;
    spawnSync("stty", [state], {
      stdio: ["inherit", "ignore", "ignore"],
    });
  };
}

export async function ensureProviderApiKey(
  options: EnsureProviderApiKeyOptions,
): Promise<EnsureProviderApiKeyResult> {
  if (options.provider === null) {
    return {
      status: "skipped",
      message: "Selected provider does not require an API key.",
    };
  }

  const normalizedProvider = options.provider.trim().toLowerCase();
  if (!isSupportedLlmProvider(normalizedProvider)) {
    throw new Error(
      `Provider '${options.provider}' does not have a supported API-key setup flow.`,
    );
  }
  const provider = normalizedProvider;
  const providerName = formatProviderName(provider);
  const envVarName = LLM_PROVIDER_ENV_VAR_NAMES[provider];
  const fetchImpl = options.fetchImpl ?? fetch;

  const existing = await readGatewayApiKey(
    options.gatewayUrl,
    provider,
    options.bearerToken,
    fetchImpl,
  );
  if (existing.unreachable) {
    return {
      status: "failed",
      provider,
      message:
        "Assistant credential store is unavailable. Try again after the assistant finishes starting.",
    };
  }
  if (existing.found) {
    return {
      status: "already_configured",
      provider,
    };
  }

  const envValue = options.env?.[envVarName]?.trim();
  let apiKey = envValue;
  let source: ProviderApiKeySource = "env";

  if (!apiKey) {
    source = "prompt";
    if (options.prompt) {
      apiKey = (
        await options.prompt(
          `Enter your ${providerName} API key (${envVarName}): `,
        )
      ).trim();
    } else {
      const stdinIsTTY = options.stdinIsTTY ?? process.stdin.isTTY;
      if (!stdinIsTTY) {
        return {
          status: "missing",
          provider,
          message: `Missing ${envVarName}. Set it in the environment or run vellum setup from an interactive terminal.`,
        };
      }
      apiKey = (
        await promptSecret(
          `Enter your ${providerName} API key (${envVarName}): `,
          {
            input: options.input,
            output: options.output,
          },
        )
      ).trim();
    }
  }

  if (!apiKey) {
    return {
      status: "missing",
      provider,
      message: "API key cannot be empty.",
    };
  }

  await injectGatewayApiKey(
    options.gatewayUrl,
    provider,
    apiKey,
    options.bearerToken,
    fetchImpl,
  );

  return {
    status: "configured",
    provider,
    source,
  };
}

export async function configureHatchProviderApiKey(
  options: HatchProviderApiKeyOptions,
): Promise<void> {
  const log = options.log ?? console.log;
  const { provider } = options;

  if (provider === null) {
    log("Provider credentials not required for the selected provider.");
    return;
  }

  try {
    const result = await ensureProviderApiKey({
      gatewayUrl: options.gatewayUrl,
      provider,
      bearerToken: options.bearerToken,
      env: options.env,
      fetchImpl: options.fetchImpl,
      prompt: options.prompt,
      stdinIsTTY: options.stdinIsTTY,
      input: options.input,
      output: options.output,
    });

    if (result.status === "already_configured") {
      log(
        `Provider credentials already configured for ${formatProviderName(result.provider)}.`,
      );
      return;
    }

    if (result.status === "configured") {
      if (result.source === "env") {
        log(
          `Configured ${formatProviderName(result.provider)} credentials from ${LLM_PROVIDER_ENV_VAR_NAMES[result.provider]}.`,
        );
      } else {
        log(`Configured ${formatProviderName(result.provider)} credentials.`);
      }
      return;
    }

    if (result.status === "skipped") {
      log(result.message);
      return;
    }

    log(
      `⚠️  Provider credential setup skipped: ${result.message}\n` +
        `   The assistant is still hatched. Run \`vellum setup --provider ${provider}\` to finish setup.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(
      `⚠️  Provider credential setup failed: ${message}\n` +
        `   The assistant is still hatched. Run \`vellum setup --provider ${provider}\` after fixing the issue.`,
    );
  }
}
