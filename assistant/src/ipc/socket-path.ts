import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getWorkspaceDir } from "../util/platform.js";

const DARWIN_UNIX_SOCKET_MAX_PATH_BYTES = 103;
const DEFAULT_UNIX_SOCKET_MAX_PATH_BYTES = 107;
const IPC_TMP_DIR_NAME = "vellum-ipc";

export type IpcSocketPathSource =
  | "env-override"
  | "workspace"
  | "tmp-hash"
  | "tmp-short-hash";

export interface IpcSocketPathResolution {
  path: string;
  source: IpcSocketPathSource;
}

function getUnixSocketMaxPathBytes(): number {
  return process.platform === "darwin"
    ? DARWIN_UNIX_SOCKET_MAX_PATH_BYTES
    : DEFAULT_UNIX_SOCKET_MAX_PATH_BYTES;
}

function isPathWithinSocketLimit(path: string, maxPathBytes: number): boolean {
  return Buffer.byteLength(path, "utf8") <= maxPathBytes;
}

/**
 * Derive the env var name and socket filename from a socket name.
 *
 * Examples:
 *   "gateway"         → { envVar: "GATEWAY_IPC_SOCKET_DIR", fileName: "gateway.sock" }
 *   "assistant"       → { envVar: "ASSISTANT_IPC_SOCKET_DIR", fileName: "assistant.sock" }
 *   "assistant-skill" → { envVar: "ASSISTANT_SKILL_IPC_SOCKET_DIR", fileName: "assistant-skill.sock" }
 */
function deriveSocketNames(socketName: string): {
  envVar: string;
  fileName: string;
} {
  const envVar = `${socketName.toUpperCase().replace(/-/g, "_")}_IPC_SOCKET_DIR`;
  const fileName = `${socketName}.sock`;
  return { envVar, fileName };
}

/**
 * Resolve the path to an IPC socket file.
 *
 * Resolution order:
 *   1. `${SOCKET_NAME}_IPC_SOCKET_DIR` env var override — used in
 *      containerized deployments (emptyDir volume) and by hatch on macOS
 *      when the workspace path would exceed the AF_UNIX limit.
 *   2. `{workspaceDir}/{socketName}.sock` — default for local dev.
 *   3. tmpdir fallback — if the workspace path exceeds the platform's
 *      AF_UNIX path limit (103 bytes on macOS, 107 on Linux).
 */
export function resolveIpcSocketPath(
  socketName: string,
): IpcSocketPathResolution {
  const workspaceDir = getWorkspaceDir();
  const { envVar, fileName } = deriveSocketNames(socketName);

  // Explicit override via env var.
  const envSocketDir = process.env[envVar]?.trim();
  if (envSocketDir) {
    return {
      path: join(envSocketDir, fileName),
      source: "env-override",
    };
  }

  const maxPathBytes = getUnixSocketMaxPathBytes();
  const workspacePath = join(workspaceDir, fileName);

  if (isPathWithinSocketLimit(workspacePath, maxPathBytes)) {
    return {
      path: workspacePath,
      source: "workspace",
    };
  }

  // Workspace path exceeds AF_UNIX limit — fall back to tmpdir.
  const hash = createHash("sha256")
    .update(workspacePath)
    .digest("hex")
    .slice(0, 12);
  const hashedPath = join(tmpdir(), IPC_TMP_DIR_NAME, `${hash}-${fileName}`);
  if (isPathWithinSocketLimit(hashedPath, maxPathBytes)) {
    return {
      path: hashedPath,
      source: "tmp-hash",
    };
  }

  return {
    path: join(tmpdir(), `v-${hash}.sock`),
    source: "tmp-short-hash",
  };
}
