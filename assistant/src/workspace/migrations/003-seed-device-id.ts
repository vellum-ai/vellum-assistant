import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { getBaseDataDir } from "../../config/env-registry.js";
import type { WorkspaceMigration } from "./types.js";

export const seedDeviceIdMigration: WorkspaceMigration = {
  id: "003-seed-device-id",
  description:
    "Seed ~/.vellum/device.json deviceId from the most recent lockfile installationId for continuity",
  run(_workspaceDir: string): void {
    const base = getBaseDataDir() || homedir();
    const vellumDir = join(base, ".vellum");
    const devicePath = join(vellumDir, "device.json");

    // a. If device.json already has a deviceId, nothing to do.
    if (existsSync(devicePath)) {
      try {
        const parsed = JSON.parse(readFileSync(devicePath, "utf-8"));
        if (
          parsed &&
          typeof parsed === "object" &&
          typeof parsed.deviceId === "string" &&
          parsed.deviceId
        ) {
          return;
        }
      } catch {
        // Unreadable or malformed — fall through and try to seed.
      }
    }

    // b. Read the lockfile to find an existing installationId.
    const lockPath = join(base, ".vellum.lock.json");
    if (!existsSync(lockPath)) return;

    let lockData: Record<string, unknown>;
    try {
      const raw = JSON.parse(readFileSync(lockPath, "utf-8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
      lockData = raw as Record<string, unknown>;
    } catch {
      return;
    }

    const assistants = lockData.assistants as
      | Array<Record<string, unknown>>
      | undefined;
    if (!Array.isArray(assistants) || assistants.length === 0) return;

    // c. Find the most recently hatched entry with an installationId.
    const withInstallId = assistants.filter(
      (a) => typeof a.installationId === "string" && a.installationId,
    );
    if (withInstallId.length === 0) return;

    withInstallId.sort((a, b) => {
      const ta =
        typeof a.hatchedAt === "string" ? new Date(a.hatchedAt).getTime() : 0;
      const tb =
        typeof b.hatchedAt === "string" ? new Date(b.hatchedAt).getTime() : 0;
      return tb - ta;
    });

    const seedId = withInstallId[0].installationId as string;

    // d. Write device.json, preserving any existing fields.
    let existing: Record<string, unknown> = {};
    if (existsSync(devicePath)) {
      try {
        const parsed = JSON.parse(readFileSync(devicePath, "utf-8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          existing = parsed as Record<string, unknown>;
        }
      } catch {
        // Malformed — start fresh.
      }
    }
    existing.deviceId = seedId;

    try {
      mkdirSync(vellumDir, { recursive: true });
      writeFileSync(devicePath, JSON.stringify(existing, null, 2) + "\n", {
        mode: 0o644,
      });
    } catch {
      // Best-effort — getDeviceId() will generate a new one if this fails.
    }
  },
};
