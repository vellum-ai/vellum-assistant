import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

export const webSearchProviderRenameMigration: WorkspaceMigration = {
  id: "007-web-search-provider-rename",
  description:
    'Rename web-search provider from "anthropic-native" to "inference-provider-native"',
  run(workspaceDir: string): void {
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

    const services = config.services;
    if (!services || typeof services !== "object" || Array.isArray(services))
      return;

    const webSearch = (services as Record<string, unknown>)["web-search"];
    if (!webSearch || typeof webSearch !== "object" || Array.isArray(webSearch))
      return;

    const ws = webSearch as Record<string, unknown>;
    if (ws.provider !== "anthropic-native") return;

    ws.provider = "inference-provider-native";
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
};
