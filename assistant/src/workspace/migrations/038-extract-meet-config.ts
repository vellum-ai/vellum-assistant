import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Extract `services.meet` from the global `config.json` into a standalone
 * `config/meet.json` file owned by the meet-join skill.
 *
 * Prior to this migration the meet config lived at `config.json` →
 * `services.meet`. The skill now reads from `config/meet.json` via
 * `getMeetConfig()`, so existing user settings must be carried over.
 *
 * Idempotent: skips workspaces that already have `config/meet.json` or
 * that never had `services.meet`.
 */
export const extractMeetConfigMigration: WorkspaceMigration = {
  id: "038-extract-meet-config",
  description:
    "Move services.meet from config.json to config/meet.json for skill-owned config",

  run(workspaceDir: string): void {
    const configPath = join(workspaceDir, "config.json");
    const meetConfigPath = join(workspaceDir, "config", "meet.json");

    // Already migrated — nothing to do.
    if (existsSync(meetConfigPath)) return;

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

    const servicesObj = services as Record<string, unknown>;
    const meet = servicesObj.meet;
    if (meet == null || typeof meet !== "object" || Array.isArray(meet)) return;

    // Write the meet config to its new location.
    mkdirSync(dirname(meetConfigPath), { recursive: true });
    writeFileSync(meetConfigPath, JSON.stringify(meet, null, 2) + "\n");

    // Remove meet from global config and write back.
    delete servicesObj.meet;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },

  down(workspaceDir: string): void {
    const configPath = join(workspaceDir, "config.json");
    const meetConfigPath = join(workspaceDir, "config", "meet.json");

    if (!existsSync(meetConfigPath)) return;

    let meet: unknown;
    try {
      meet = JSON.parse(readFileSync(meetConfigPath, "utf-8"));
    } catch {
      return;
    }

    // Read the global config (or start fresh).
    let config: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      try {
        const raw = JSON.parse(readFileSync(configPath, "utf-8"));
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          config = raw as Record<string, unknown>;
        }
      } catch {
        // Malformed — start with empty object.
      }
    }

    const services =
      config.services != null &&
      typeof config.services === "object" &&
      !Array.isArray(config.services)
        ? (config.services as Record<string, unknown>)
        : {};

    services.meet = meet;
    config.services = services;

    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

    // Remove the skill-owned file so a subsequent run() re-migrates cleanly.
    try {
      unlinkSync(meetConfigPath);
    } catch {
      // Best-effort cleanup.
    }
  },
};
