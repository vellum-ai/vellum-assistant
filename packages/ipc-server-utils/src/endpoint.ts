import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { posix, win32 } from "node:path";

const DARWIN_UNIX_SOCKET_MAX_PATH_BYTES = 103;
const DEFAULT_UNIX_SOCKET_MAX_PATH_BYTES = 107;
const IPC_TMP_DIR_NAME = "vellum-ipc";
const join = posix.join;

export type IpcSocketPathSource =
  | "env-override"
  | "workspace"
  | "tmp-hash"
  | "tmp-short-hash"
  | "windows-named-pipe";

export interface IpcSocketPathResolution {
  path: string;
  source: IpcSocketPathSource;
}

export interface IpcEndpointOptions {
  workspaceDir: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}

function getUnixSocketMaxPathBytes(platform: NodeJS.Platform): number {
  return platform === "darwin"
    ? DARWIN_UNIX_SOCKET_MAX_PATH_BYTES
    : DEFAULT_UNIX_SOCKET_MAX_PATH_BYTES;
}

function isPathWithinSocketLimit(path: string, maxPathBytes: number): boolean {
  return Buffer.byteLength(path, "utf8") <= maxPathBytes;
}

/**
 * Derive the env var name and socket filename from a socket name.
 *
 * Examples (hyphens in the name become underscores in the env var):
 */
function deriveSocketNames(socketName: string): {
  envVar: string;
  fileName: string;
} {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(socketName)) {
    throw new Error(`Invalid IPC endpoint name: ${socketName}`);
  }
  const envVar = `${socketName.toUpperCase().replace(/-/g, "_")}_IPC_SOCKET_DIR`;
  const fileName = `${socketName}.sock`;
  return { envVar, fileName };
}

function resolveWindowsNamedPipe(
  socketName: string,
  workspaceDir: string,
): IpcSocketPathResolution {
  const workspaceIdentity = win32
    .normalize(workspaceDir)
    .replace(/\\+$/, "")
    .toLowerCase();
  const hash = createHash("sha256")
    .update(`${workspaceIdentity}\0${socketName}`)
    .digest("hex")
    .slice(0, 24);
  return {
    path: `\\\\.\\pipe\\vellum-${socketName}-${hash}`,
    source: "windows-named-pipe",
  };
}

export function isNamedPipePath(endpointPath: string): boolean {
  return /^\\\\[.?]\\pipe\\/.test(endpointPath);
}

export function removeIpcEndpointFile(endpointPath: string): void {
  if (isNamedPipePath(endpointPath)) {
    return;
  }
  try {
    unlinkSync(endpointPath);
  } catch {
    // Already absent.
  }
}

/**
 * Resolve the path to an IPC socket file.
 *
 * Resolution order:
 * POSIX uses overrides, workspace paths, then bounded temporary paths.
 * Windows uses deterministic named pipes.
 */
export function resolveIpcEndpoint(
  socketName: string,
  options: IpcEndpointOptions,
): IpcSocketPathResolution {
  const { envVar, fileName } = deriveSocketNames(socketName);
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return resolveWindowsNamedPipe(socketName, options.workspaceDir);
  }

  // Explicit override via env var.
  const envSocketDir = (options.env ?? process.env)[envVar]?.trim();
  if (envSocketDir) {
    return {
      path: join(envSocketDir, fileName),
      source: "env-override",
    };
  }

  const maxPathBytes = getUnixSocketMaxPathBytes(platform);
  const workspacePath = join(options.workspaceDir, fileName);

  if (isPathWithinSocketLimit(workspacePath, maxPathBytes)) {
    return {
      path: workspacePath,
      source: "workspace",
    };
  }

  // Workspace path exceeds AF_UNIX limit - fall back to tmpdir.
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
