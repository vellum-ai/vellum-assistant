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

interface CatalogLookup {
  catalogPath: string;
  providers: Map<string, string>;
  models: Map<string, string>;
  modelsByProvider: Map<string, Map<string, string>>;
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

function outputJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data) + "\n");
}

function outputJsonError(message: string): void {
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

function loadCatalogLookup(): CatalogLookup | null {
  const catalogFile = readCatalogFile();
  if (!catalogFile) {
    return null;
  }

  try {
    const catalog = JSON.parse(catalogFile.raw) as CatalogFile;
    const providers = new Map<string, string>();
    const models = new Map<string, string>();
    const modelsByProvider = new Map<string, Map<string, string>>();

    for (const provider of catalog.providers ?? []) {
      if (!provider.id) {
        continue;
      }

      if (provider.displayName) {
        providers.set(provider.id, provider.displayName);
      }

      const providerModels = new Map<string, string>();
      for (const model of provider.models ?? []) {
        if (!model.id || !model.displayName) {
          continue;
        }

        providerModels.set(model.id, model.displayName);
        if (!models.has(model.id)) {
          models.set(model.id, model.displayName);
        }
      }

      modelsByProvider.set(provider.id, providerModels);
    }

    return {
      catalogPath: catalogFile.catalogPath,
      providers,
      models,
      modelsByProvider,
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
  if (!raw || raw === "(not set)") {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function stringField(
  value: unknown,
  fallback: string | undefined = undefined
): string | undefined {
  return typeof value === "string" && value.trim() ? value : fallback;
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
      model: stringField(llmConfig.model, stringField(inferenceConfig.model)),
      provider: stringField(
        llmConfig.provider,
        stringField(inferenceConfig.provider)
      ),
      mode: stringField(inferenceConfig.mode),
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
  lookup: CatalogLookup | null,
  providerId: string,
  modelId: string
): string {
  return (
    lookup?.modelsByProvider.get(providerId)?.get(modelId) ??
    lookup?.models.get(modelId) ??
    modelId
  );
}

function getProviderDisplayName(
  lookup: CatalogLookup | null,
  providerId: string
): string {
  return lookup?.providers.get(providerId) ?? providerId;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const jsonMode = process.argv.includes("--json");

  try {
    const catalog = loadCatalogLookup();
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
      outputJson({
        ok: true,
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
