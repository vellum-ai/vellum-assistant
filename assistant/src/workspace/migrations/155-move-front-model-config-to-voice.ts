import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migration-155");

/**
 * Move `liveVoice.frontModel` to `voice.frontModel` in `config.json`.
 *
 * The front-door tuning (endpointing budgets and progress narration cadence)
 * is read by phone calls as well as live voice, so it lives under a
 * transport-agnostic key. A `voice.frontModel` already present wins field by
 * field; the old block is removed either way so raw-config saves stop
 * writing it back.
 */
export const moveFrontModelConfigToVoiceMigration: WorkspaceMigration = {
  id: "155-move-front-model-config-to-voice",
  description: "Move liveVoice.frontModel to voice.frontModel in config.json",
  run(workspaceDir: string): void {
    const configPath = join(workspaceDir, "config.json");
    if (!existsSync(configPath)) {
      return;
    }

    let config: Record<string, unknown>;
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return;
      }
      config = raw as Record<string, unknown>;
    } catch {
      return;
    }

    const liveVoice = readObject(config.liveVoice);
    if (liveVoice === null || !Object.hasOwn(liveVoice, "frontModel")) {
      return;
    }
    const legacy = readObject(liveVoice.frontModel);
    delete liveVoice.frontModel;

    if (legacy !== null) {
      const voice = readObject(config.voice) ?? {};
      const current = readObject(voice.frontModel) ?? {};
      const legacyProgress = readObject(legacy.progress) ?? {};
      const currentProgress = readObject(current.progress) ?? {};
      const merged: Record<string, unknown> = { ...legacy, ...current };
      if (
        Object.keys(legacyProgress).length > 0 ||
        Object.keys(currentProgress).length > 0
      ) {
        merged.progress = { ...legacyProgress, ...currentProgress };
      }
      voice.frontModel = merged;
      config.voice = voice;
    }

    const tmpPath = `${configPath}.migration-155.tmp`;
    writeFileSync(tmpPath, JSON.stringify(config, null, 2) + "\n");
    renameSync(tmpPath, configPath);
    log.info("Moved liveVoice.frontModel to voice.frontModel in config.json");
  },
  retryFailedCheckpoint: true,
  down(_workspaceDir: string): void {
    // Forward-only: the schema no longer carries liveVoice.frontModel, so
    // moving it back would only be stripped on the next load.
  },
};

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
