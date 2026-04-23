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

import { readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CatalogModel {
  id: string;
  displayName?: string;
}

interface CatalogProvider {
  id: string;
  displayName?: string;
  models?: CatalogModel[];
}

interface CatalogFile {
  providers?: CatalogProvider[];
}

interface CatalogData {
  catalogPath: string;
  catalog: CatalogFile;
}

interface CommandResult {
  ok: boolean;
  stdout?: string;
  error?: string;
}

interface InferenceConfig {
  model?: string;
  provider?: string;
  mode?: string;
}

interface CatalogFileRead {
  catalogPath: string;
  raw: string;
}

const DEFAULT_INFERENCE_CONFIG: Required<InferenceConfig> = {
  model: "claude-sonnet-4-6",
  provider: "anthropic",
  mode: "your-own",
};

function outputJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data) + "\n");
}

function outputJsonError(message: string): void {
  process.exitCode = 1;
  outputJson({ ok: false, error: message });
}

function readCatalogFile(): CatalogFileRead | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  const root = parse(dir).root;

  while (true) {
    const candidate = join(dir, "meta", "llm-provider-catalog.json");
    try {
      return {
        catalogPath: candidate,
        raw: readFileSync(candidate, "utf-8"),
      };
    } catch {
      if (dir === root) {
        return null;
      }

      dir = dirname(dir);
    }
  }
}

function loadCatalog(): CatalogData | null {
  const catalogFile = readCatalogFile();
  if (!catalogFile) {
    return null;
  }

  try {
    return {
      catalogPath: catalogFile.catalogPath,
      catalog: JSON.parse(catalogFile.raw) as CatalogFile,
    };
  } catch {
    return null;
  }
}

async function readConfigValue(key: string): Promise<CommandResult> {
  try {
    const proc = Bun.spawn(["assistant", "config", "get", key], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      return {
        ok: false,
        error:
          stderr.trim() || `assistant config get ${key} exited ${exitCode}`,
      };
    }

    return { ok: true, stdout: stdout.trim() };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function parseConfigObject(raw: string | undefined): Record<string, unknown> {
  const value = raw?.trim();
  if (!value || value === "(not set)") {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function stringField(
  value: unknown,
  fallback: string | undefined = undefined,
): string | undefined {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed && trimmed !== "(not set)" ? trimmed : fallback;
}

async function readInferenceConfig(): Promise<{
  config: InferenceConfig;
  available: boolean;
  error?: string;
}> {
  const [llmDefault, inference] = await Promise.all([
    readConfigValue("llm.default"),
    readConfigValue("services.inference"),
  ]);

  if (!llmDefault.ok && !inference.ok) {
    return {
      config: {},
      available: false,
      error: llmDefault.error ?? inference.error,
    };
  }

  const llmConfig = llmDefault.ok ? parseConfigObject(llmDefault.stdout) : {};
  const inferenceConfig = inference.ok
    ? parseConfigObject(inference.stdout)
    : {};

  return {
    config: {
      model: stringField(
        llmConfig.model,
        stringField(inferenceConfig.model, DEFAULT_INFERENCE_CONFIG.model),
      ),
      provider: stringField(
        llmConfig.provider,
        stringField(
          inferenceConfig.provider,
          DEFAULT_INFERENCE_CONFIG.provider,
        ),
      ),
      mode: stringField(inferenceConfig.mode, DEFAULT_INFERENCE_CONFIG.mode),
    },
    available: true,
    error: !llmDefault.ok
      ? llmDefault.error
      : !inference.ok
        ? inference.error
        : undefined,
  };
}

function getModelDisplayName(
  catalog: CatalogData | null,
  providerId: string,
  modelId: string,
): string {
  const provider = catalog?.catalog.providers?.find(
    (entry) => entry.id === providerId,
  );
  const providerModel = provider?.models?.find((model) => model.id === modelId);
  if (providerModel?.displayName) {
    return providerModel.displayName;
  }

  const catalogModel = catalog?.catalog.providers
    ?.flatMap((entry) => entry.models ?? [])
    .find((model) => model.id === modelId);

  return catalogModel?.displayName ?? modelId;
}

function getProviderDisplayName(
  catalog: CatalogData | null,
  providerId: string,
): string {
  return (
    catalog?.catalog.providers?.find((provider) => provider.id === providerId)
      ?.displayName ?? providerId
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const jsonMode = process.argv.includes("--json");

  try {
    const catalog = loadCatalog();
    const { config, available, error } = await readInferenceConfig();

    const modelId = config.model ?? "unknown";
    const providerId = config.provider ?? "unknown";
    const mode = config.mode ?? "unknown";

    const modelDisplayName = getModelDisplayName(catalog, providerId, modelId);
    const providerDisplayName = getProviderDisplayName(catalog, providerId);

    const modeLabel =
      mode === "your-own"
        ? "your-own API key"
        : mode === "managed"
          ? "managed platform proxy"
          : mode;

    const summary = available
      ? `You are running as ${modelDisplayName} via ${providerDisplayName} (${modeLabel}).`
      : `Current assistant inference configuration is unavailable${
          error ? `: ${error}` : "."
        }`;

    if (jsonMode) {
      if (!available) {
        process.exitCode = 1;
      }

      outputJson({
        ok: available,
        configAvailable: available,
        ...(error ? { configWarning: error } : {}),
        catalog: catalog
          ? { available: true, path: catalog.catalogPath }
          : { available: false },
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
    }
  }
}

main();
