import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getWorkspaceDir } from "../util/platform.js";

const DARWIN_UNIX_SOCKET_MAX_PATH_BYTES = 103;
const DEFAULT_UNIX_SOCKET_MAX_PATH_BYTES = 107;
const IPC_TMP_DIR_NAME = "vellum-ipc";
const IPC_BASE_DATA_DIR_NAME = "ipc";

export type IpcSocketPathSource =
  | "workspace"
  | "base-data-dir"
  | "tmp-hash"
  | "tmp-short-hash";

export interface IpcSocketPathResolution {
  path: string;
  source: IpcSocketPathSource;
  workspacePath: string;
  maxPathBytes: number;
}

function getUnixSocketMaxPathBytes(): number {
  return process.platform === "darwin"
    ? DARWIN_UNIX_SOCKET_MAX_PATH_BYTES
    : DEFAULT_UNIX_SOCKET_MAX_PATH_BYTES;
}

function isPathWithinSocketLimit(path: string, maxPathBytes: number): boolean {
  return Buffer.byteLength(path, "utf8") <= maxPathBytes;
}

function buildBaseDataDirCandidate(socketFileName: string): string | null {
  const baseDataDir = process.env.BASE_DATA_DIR?.trim();
  if (!baseDataDir) return null;
  return join(baseDataDir, IPC_BASE_DATA_DIR_NAME, socketFileName);
}

function buildTmpCandidate(
  workspacePath: string,
  socketFileName: string,
): { hashedPath: string; shortPath: string } {
  const hash = createHash("sha256")
    .update(workspacePath)
    .digest("hex")
    .slice(0, 12);
  return {
    hashedPath: join(tmpdir(), IPC_TMP_DIR_NAME, `${hash}-${socketFileName}`),
    shortPath: join(tmpdir(), `v-${hash}.sock`),
  };
}

export function resolveIpcSocketPath(
  socketFileName: string,
  workspaceDir: string = getWorkspaceDir(),
): IpcSocketPathResolution {
  const maxPathBytes = getUnixSocketMaxPathBytes();
  const workspacePath = join(workspaceDir, socketFileName);

  if (isPathWithinSocketLimit(workspacePath, maxPathBytes)) {
    return {
      path: workspacePath,
      source: "workspace",
      workspacePath,
      maxPathBytes,
    };
  }

  const baseDataDirCandidate = buildBaseDataDirCandidate(socketFileName);
  if (
    baseDataDirCandidate &&
    isPathWithinSocketLimit(baseDataDirCandidate, maxPathBytes)
  ) {
    return {
      path: baseDataDirCandidate,
      source: "base-data-dir",
      workspacePath,
      maxPathBytes,
    };
  }

  const tmpCandidate = buildTmpCandidate(workspacePath, socketFileName);
  if (isPathWithinSocketLimit(tmpCandidate.hashedPath, maxPathBytes)) {
    return {
      path: tmpCandidate.hashedPath,
      source: "tmp-hash",
      workspacePath,
      maxPathBytes,
    };
  }

  return {
    path: tmpCandidate.shortPath,
    source: "tmp-short-hash",
    workspacePath,
    maxPathBytes,
  };
}
