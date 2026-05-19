import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { exists, readTextFile } from "@tauri-apps/plugin-fs";

import type { AssistantConnection } from "../types.js";
import { isTauriRuntime } from "./tauri-runtime.js";

interface LockfileAssistantEntry {
  readonly assistantId?: string;
  readonly hatchedAt?: string;
  readonly cloud?: string;
  readonly runtimeUrl?: string;
  readonly resources?: {
    readonly gatewayPort?: number;
  };
}

interface Lockfile {
  readonly assistants?: LockfileAssistantEntry[];
}

const LOCKFILE_NAMES = [".vellum.lock.json", ".vellum.lockfile.json"] as const;
const DEFAULT_GATEWAY_PORT = 7830;

/**
 * Resolve the local assistant's connection info by reading the standard
 * Vellum lockfile candidates from `$HOME`. Returns `null` when no usable
 * lockfile entry is present so the caller can render an "offline" state
 * instead of throwing.
 */
export async function resolveLocalAssistantConnection(): Promise<AssistantConnection | null> {
  if (!isTauriRuntime()) {
    return browserDevConnection();
  }

  const home = await homeDir();

  for (const name of LOCKFILE_NAMES) {
    const path = joinPath(home, name);
    if (!(await safeExists(path))) continue;

    const raw = await safeReadText(path);
    if (!raw) continue;

    const parsed = parseLockfile(raw);
    if (!parsed) continue;

    const entry = pickEntry(parsed.assistants ?? []);
    if (!entry) continue;

    const runtime = pickRuntimeUrl(entry);
    if (!runtime) continue;

    const assistantId = entry.assistantId ?? "self";
    const bearerToken = await safeGuardianAccessToken(assistantId);
    return {
      httpBaseUrl: runtime.httpBaseUrl,
      wsBaseUrl: runtime.wsBaseUrl,
      bearerToken,
      assistantId,
    };
  }

  return null;
}

async function safeGuardianAccessToken(
  assistantId: string,
): Promise<string | null> {
  try {
    const token = await invoke<string | null>("guardian_access_token", {
      assistantId,
    });
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

function browserDevConnection(): AssistantConnection {
  const configuredBaseUrl = import.meta.env.VITE_GATEWAY_URL;
  const hasConfiguredBaseUrl =
    typeof configuredBaseUrl === "string" && configuredBaseUrl.length > 0;
  const httpBaseUrl = hasConfiguredBaseUrl
    ? configuredBaseUrl.replace(/\/+$/, "")
    : "/__gateway";
  const wsBaseUrl = hasConfiguredBaseUrl
    ? httpBaseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:")
    : `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/__gateway`;

  return {
    httpBaseUrl,
    wsBaseUrl,
    bearerToken: null,
    assistantId: "self",
  };
}

function joinPath(base: string, file: string): string {
  if (base.endsWith("/")) return `${base}${file}`;
  return `${base}/${file}`;
}

async function safeExists(path: string): Promise<boolean> {
  try {
    return await exists(path);
  } catch {
    return false;
  }
}

async function safeReadText(path: string): Promise<string | null> {
  try {
    return await readTextFile(path);
  } catch {
    return null;
  }
}

function parseLockfile(raw: string): Lockfile | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value === "object" && value !== null) {
      return value as Lockfile;
    }
  } catch {
    // ignore malformed lockfile and fall through to next candidate
  }
  return null;
}

function pickEntry(
  assistants: LockfileAssistantEntry[],
): LockfileAssistantEntry | null {
  if (assistants.length === 0) return null;
  // Most-recently-hatched wins (string comparison is fine for ISO-8601).
  return assistants.reduce<LockfileAssistantEntry | null>((best, current) => {
    if (!best) return current;
    const bestStamp = best.hatchedAt ?? "";
    const currentStamp = current.hatchedAt ?? "";
    return currentStamp > bestStamp ? current : best;
  }, null);
}

interface ResolvedRuntime {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

function pickRuntimeUrl(entry: LockfileAssistantEntry): ResolvedRuntime | null {
  const cloud = (entry.cloud ?? "local").toLowerCase();
  if (cloud !== "local" && entry.runtimeUrl) {
    return splitRuntimeUrl(entry.runtimeUrl);
  }

  const port = entry.resources?.gatewayPort ?? DEFAULT_GATEWAY_PORT;
  return {
    httpBaseUrl: `http://127.0.0.1:${port}`,
    wsBaseUrl: `ws://127.0.0.1:${port}`,
  };
}

function splitRuntimeUrl(rawUrl: string): ResolvedRuntime | null {
  try {
    const url = new URL(rawUrl);
    const httpProto = url.protocol === "https:" ? "https:" : "http:";
    const wsProto = url.protocol === "https:" ? "wss:" : "ws:";
    const httpBaseUrl = `${httpProto}//${url.host}`.replace(/\/+$/, "");
    const wsBaseUrl = `${wsProto}//${url.host}`.replace(/\/+$/, "");
    return { httpBaseUrl, wsBaseUrl };
  } catch {
    return null;
  }
}
