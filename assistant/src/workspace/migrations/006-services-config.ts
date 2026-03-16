import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { credentialKey } from "../../security/credential-key.js";
import {
  getProviderKeyAsync,
  getSecureKeyAsync,
} from "../../security/secure-keys.js";
import type { WorkspaceMigration } from "./types.js";

export const servicesConfigMigration: WorkspaceMigration = {
  id: "006-services-config",
  description:
    "Move top-level provider/model/imageGenModel/webSearchProvider into services object with mode",
  async run(workspaceDir: string): Promise<void> {
    const configPath = join(workspaceDir, "config.json");
    if (!existsSync(configPath)) return;

    let config: Record<string, unknown>;
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
      config = raw as Record<string, unknown>;
    } catch {
      return;
    }

    // Already migrated -- skip (idempotency guard for crash recovery)
    if (config.services !== undefined) return;

    // Determine inference mode
    let inferenceMode: "managed" | "your-own" = "your-own";
    try {
      // Check if the user has ANY inference provider key configured.
      // If so, keep "your-own" regardless of managed credentials.
      const inferenceProviders = [
        "anthropic",
        "openai",
        "gemini",
        "fireworks",
        "openrouter",
      ];
      let hasAnyUserKey = false;
      for (const p of inferenceProviders) {
        if (await getProviderKeyAsync(p)) {
          hasAnyUserKey = true;
          break;
        }
      }
      if (!hasAnyUserKey) {
        const apiKey = await getSecureKeyAsync(
          credentialKey("vellum", "assistant_api_key"),
        );
        const baseUrl = await getSecureKeyAsync(
          credentialKey("vellum", "platform_base_url"),
        );
        if (apiKey && baseUrl) {
          inferenceMode = "managed";
        }
      }
    } catch {
      // Can't determine -- default to "your-own"
    }

    const services: Record<string, Record<string, unknown>> = {};

    services.inference = {
      mode: inferenceMode,
      provider:
        typeof config.provider === "string" ? config.provider : "anthropic",
      model:
        typeof config.model === "string" ? config.model : "claude-opus-4-6",
    };

    const imageGenModel =
      typeof config.imageGenModel === "string"
        ? config.imageGenModel
        : "gemini-2.5-flash-image";
    services["image-generation"] = {
      mode: "your-own",
      provider:
        imageGenModel.startsWith("dall-e") || imageGenModel.startsWith("gpt")
          ? "openai"
          : "gemini",
      model: imageGenModel,
    };

    services["web-search"] = {
      mode: "your-own",
      provider:
        typeof config.webSearchProvider === "string"
          ? config.webSearchProvider
          : "anthropic-native",
    };

    config.services = services;
    delete config.provider;
    delete config.model;
    delete config.imageGenModel;
    delete config.webSearchProvider;

    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
};
