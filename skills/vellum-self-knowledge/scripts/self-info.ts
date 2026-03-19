#!/usr/bin/env bun
/**
 * CLI for vellum-self-knowledge skill: `bun run scripts/self-info.ts`
 *
 * Queries the current inference configuration and returns structured JSON
 * with the active model, provider, and mode.
 */

// ---------------------------------------------------------------------------
// Display name mappings (mirrors model-catalog.ts)
// ---------------------------------------------------------------------------

const MODEL_DISPLAY_NAMES: Record<string, string> = {
  "claude-opus-4-6": "Claude Opus 4.6",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-haiku-4-5-20251001": "Claude Haiku 4.5",
  "gpt-5.2": "GPT-5.2",
  "gpt-5.4": "GPT-5.4",
  "gpt-5.4-nano": "GPT-5.4 Nano",
  "gemini-3-flash": "Gemini 3 Flash",
  "gemini-3-pro": "Gemini 3 Pro",
  "llama3.2": "Llama 3.2",
  mistral: "Mistral",
  "accounts/fireworks/models/kimi-k2p5": "Kimi K2.5",
  "x-ai/grok-4": "Grok 4",
  "x-ai/grok-4.20-beta": "Grok 4.20 Beta",
};

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Google Gemini",
  ollama: "Ollama",
  fireworks: "Fireworks",
  openrouter: "OpenRouter",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function output(data: unknown): void {
  process.stdout.write(JSON.stringify(data) + "\n");
}

function outputError(message: string, code = 1): void {
  output({ ok: false, error: message });
  process.exitCode = code;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  try {
    const proc = Bun.spawn(["assistant", "config", "get", "services.inference"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      outputError(`Failed to read inference config: ${stderr.trim() || "unknown error"}`);
      return;
    }

    const raw = stdout.trim();

    // When the inference config hasn't been explicitly set, the CLI returns
    // the literal string "(not set)". Fall back to sensible defaults rather
    // than crashing with a cryptic JSON-parse error.
    let config: { model?: string; provider?: string; mode?: string };
    if (raw === "(not set)" || raw === "") {
      config = {
        model: "claude-opus-4-6",
        provider: "anthropic",
        mode: "unknown",
      };
    } else {
      config = JSON.parse(raw) as {
        model?: string;
        provider?: string;
        mode?: string;
      };
    }

    const modelId = config.model ?? "unknown";
    const providerId = config.provider ?? "unknown";
    const mode = config.mode ?? "unknown";

    const modelDisplayName = MODEL_DISPLAY_NAMES[modelId] ?? modelId;
    const providerDisplayName = PROVIDER_DISPLAY_NAMES[providerId] ?? providerId;

    const modeLabel = mode === "your-own" ? "your-own API key" : mode === "managed" ? "managed platform proxy" : mode;

    output({
      ok: true,
      model: { id: modelId, displayName: modelDisplayName },
      provider: { id: providerId, displayName: providerDisplayName },
      mode,
      summary: `You are running as ${modelDisplayName} via ${providerDisplayName} (${modeLabel}).`,
    });
  } catch (err) {
    outputError(err instanceof Error ? err.message : String(err));
  }
}

main();
