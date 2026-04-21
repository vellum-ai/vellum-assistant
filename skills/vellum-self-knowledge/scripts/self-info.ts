#!/usr/bin/env bun
/**
 * Self-info script for the vellum-self-knowledge skill.
 *
 * Queries the current inference configuration and emits a human-readable
 * summary to stdout. The output is designed to be injected directly into
 * the prompt via inline command expansion (`!\`...\``), but also works
 * when run directly from the command line.
 *
 * Pass `--json` for structured JSON output (backwards-compatible with
 * earlier versions that always emitted JSON).
 */

// ---------------------------------------------------------------------------
// Display name mappings (mirrors model-catalog.ts)
// ---------------------------------------------------------------------------

const MODEL_DISPLAY_NAMES: Record<string, string> = {
  "claude-opus-4-7": "Claude Opus 4.7",
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
  "deepseek/deepseek-r1-0528": "DeepSeek R1",
  "deepseek/deepseek-chat-v3-0324": "DeepSeek V3",
  "qwen/qwen3.5-plus-02-15": "Qwen 3.5 Plus",
  "qwen/qwen3.5-397b-a17b": "Qwen 3.5 397B",
  "qwen/qwen3.5-flash-02-23": "Qwen 3.5 Flash",
  "qwen/qwen3-coder-next": "Qwen 3 Coder",
  "moonshotai/kimi-k2.5": "Kimi K2.5",
  "mistralai/mistral-medium-3": "Mistral Medium 3",
  "mistralai/mistral-small-2603": "Mistral Small 4",
  "mistralai/devstral-2512": "Devstral 2",
  "meta-llama/llama-4-maverick": "Llama 4 Maverick",
  "meta-llama/llama-4-scout": "Llama 4 Scout",
  "amazon/nova-pro-v1": "Amazon Nova Pro",
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

function outputJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data) + "\n");
}

function outputJsonError(message: string, code = 1): void {
  outputJson({ ok: false, error: message });
  process.exitCode = code;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const jsonMode = process.argv.includes("--json");

  try {
    const proc = Bun.spawn(
      ["assistant", "config", "get", "services.inference"],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const msg = `Failed to read inference config: ${stderr.trim() || "unknown error"}`;
      if (jsonMode) {
        outputJsonError(msg);
      } else {
        process.stdout.write(`[self-info unavailable: ${msg}]\n`);
        process.exitCode = 1;
      }
      return;
    }

    const raw = stdout.trim();

    // When the inference config hasn't been explicitly set, the CLI returns
    // the literal string "(not set)". Fall back to sensible defaults rather
    // than crashing with a cryptic JSON-parse error.
    let config: { model?: string; provider?: string; mode?: string };
    if (raw === "(not set)" || raw === "") {
      config = {
        model: "claude-opus-4-7",
        provider: "anthropic",
        mode: "your-own",
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
    const providerDisplayName =
      PROVIDER_DISPLAY_NAMES[providerId] ?? providerId;

    const modeLabel =
      mode === "your-own"
        ? "your-own API key"
        : mode === "managed"
          ? "managed platform proxy"
          : mode;

    const summary = `You are running as ${modelDisplayName} via ${providerDisplayName} (${modeLabel}).`;

    if (jsonMode) {
      outputJson({
        ok: true,
        model: { id: modelId, displayName: modelDisplayName },
        provider: { id: providerId, displayName: providerDisplayName },
        mode,
        summary,
      });
    } else {
      // Plain text summary — suitable for inline command expansion
      process.stdout.write(summary + "\n");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (jsonMode) {
      outputJsonError(msg);
    } else {
      process.stdout.write(`[self-info unavailable: ${msg}]\n`);
      process.exitCode = 1;
    }
  }
}

main();
