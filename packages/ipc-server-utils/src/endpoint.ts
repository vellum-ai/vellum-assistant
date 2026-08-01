import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { posix } from "node:path";

const DARWIN_UNIX_SOCKET_MAX_PATH_BYTES = 103;
const DEFAULT_UNIX_SOCKET_MAX_PATH_BYTES = 107;
const IPC_TMP_DIR_NAME = "vellum-ipc";
const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\vellum-";
const WINDOWS_PIPE_HASH_LENGTH = 24;
export const WINDOWS_NAMED_PIPE_MAX_PATH_CHARS = 256;

export type IpcEndpointSource =
  | "env-override"
  | "workspace"
  | "tmp-hash"
  | "tmp-short-hash"
  | "windows-named-pipe";

export interface IpcEndpointResolution {
  path: string;
  source: IpcEndpointSource;
  kind: "unix-socket" | "named-pipe";
}

export interface IpcEndpointOptions {
  workspaceDir: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  tmpDir?: string;
  unixSocketMaxPathBytes?: number;
}

function deriveEndpointNames(socketName: string): {
  envVar: string;
  fileName: string;
} {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(socketName)) {
    throw new Error(`Invalid IPC endpoint name: ${socketName}`);
  }
  return {
    envVar: `${socketName.toUpperCase().replace(/-/g, "_")}_IPC_SOCKET_DIR`,
    fileName: `${socketName}.sock`,
  };
}

function unixSocketMaxPathBytes(platform: NodeJS.Platform): number {
  return platform === "darwin"
    ? DARWIN_UNIX_SOCKET_MAX_PATH_BYTES
    : DEFAULT_UNIX_SOCKET_MAX_PATH_BYTES;
}

function isWithinUnixSocketLimit(
  socketPath: string,
  maxPathBytes: number,
): boolean {
  return Buffer.byteLength(socketPath, "utf8") <= maxPathBytes;
}

function resolveWindowsNamedPipe(
  socketName: string,
  workspaceDir: string,
  override: string | undefined,
): IpcEndpointResolution {
  const hash = createHash("sha256")
    .update(`${workspaceDir}\0${override ?? ""}\0${socketName}`)
    .digest("hex")
    .slice(0, WINDOWS_PIPE_HASH_LENGTH);
  const path = `${WINDOWS_PIPE_PREFIX}${socketName}-${hash}`;
  if (path.length > WINDOWS_NAMED_PIPE_MAX_PATH_CHARS) {
    throw new Error(`IPC named pipe exceeds the Windows path limit: ${path}`);
  }
  return {
    path,
    source: override ? "env-override" : "windows-named-pipe",
    kind: "named-pipe",
  };
}

export function isNamedPipePath(endpointPath: string): boolean {
  return (
    endpointPath.startsWith("\\\\.\\pipe\\") ||
    endpointPath.startsWith("\\\\?\\pipe\\")
  );
}

export function removeIpcEndpointFile(endpointPath: string): void {
  if (isNamedPipePath(endpointPath)) {
    return;
  }
  try {
    unlinkSync(endpointPath);
  } catch {
    // Missing and already-removed endpoints need no cleanup.
  }
}

/** Resolve a local IPC endpoint without importing either service package. */
export function resolveIpcEndpoint(
  socketName: string,
  options: IpcEndpointOptions,
): IpcEndpointResolution {
  const { envVar, fileName } = deriveEndpointNames(socketName);
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const override = env[envVar]?.trim() || undefined;

  if (platform === "win32") {
    return resolveWindowsNamedPipe(socketName, options.workspaceDir, override);
  }

  if (override) {
    return {
      path: posix.join(override, fileName),
      source: "env-override",
      kind: "unix-socket",
    };
  }

  const maxPathBytes =
    options.unixSocketMaxPathBytes ?? unixSocketMaxPathBytes(platform);
  const workspacePath = posix.join(options.workspaceDir, fileName);
  if (isWithinUnixSocketLimit(workspacePath, maxPathBytes)) {
    return {
      path: workspacePath,
      source: "workspace",
      kind: "unix-socket",
    };
  }

  const hash = createHash("sha256")
    .update(workspacePath)
    .digest("hex")
    .slice(0, 12);
  const tempRoot = options.tmpDir ?? tmpdir();
  const hashedPath = posix.join(
    tempRoot,
    IPC_TMP_DIR_NAME,
    `${hash}-${fileName}`,
  );
  if (isWithinUnixSocketLimit(hashedPath, maxPathBytes)) {
    return {
      path: hashedPath,
      source: "tmp-hash",
      kind: "unix-socket",
    };
  }

  return {
    path: posix.join(tempRoot, `v-${hash}.sock`),
    source: "tmp-short-hash",
    kind: "unix-socket",
  };
}
