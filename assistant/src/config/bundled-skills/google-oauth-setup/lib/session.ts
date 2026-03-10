/**
 * GCP OAuth setup session management.
 * Persists project configuration (project ID and number) for reuse across
 * CLI invocations. Unlike the DoorDash session which stores cookies, the GCP
 * session is cookie-free — authentication goes through CDP (browser cookies).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { GCPProjectConfig } from "./types.js";

function getSessionDir(): string {
  return join(process.env.VELLUM_DATA_DIR!, "google-oauth-setup");
}

function getSessionPath(): string {
  return join(getSessionDir(), "project-config.json");
}

export function loadProjectConfig(): GCPProjectConfig | null {
  const path = getSessionPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as GCPProjectConfig;
  } catch {
    return null;
  }
}

export function saveProjectConfig(config: GCPProjectConfig): void {
  const dir = getSessionDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(getSessionPath(), JSON.stringify(config, null, 2));
}

export function clearProjectConfig(): void {
  const path = getSessionPath();
  if (existsSync(path)) unlinkSync(path);
}
