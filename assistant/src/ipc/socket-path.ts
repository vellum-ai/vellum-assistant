import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getProtectedDir } from "../util/platform.js";

const DARWIN_UNIX_SOCKET_MAX_PATH_BYTES = 103;
const DEFAULT_UNIX_SOCKET_MAX_PATH_BYTES = 107;
const IPC_TMP_DIR_NAME = "vellum-ipc";

export type IpcSocketPathSource = "protected" | "tmp-hash" | "tmp-short-hash";

export interface IpcSocketPathResolution {
  path: string;
  source: IpcSocketPathSource;
  preferredPath: string;
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

function buildTmpCandidate(
  preferredPath: string,
  socketFileName: string,
): { hashedPath: string; shortPath: string } {
  const hash = createHash("sha256")
    .update(preferredPath)
    .digest("hex")
    .slice(0, 12);
  return {
    hashedPath: join(tmpdir(), IPC_TMP_DIR_NAME, `${hash}-${socketFileName}`),
    shortPath: join(tmpdir(), `v-${hash}.sock`),
  };
}

export function resolveIpcSocketPath(
  socketFileName: string,
  baseDir: string = getProtectedDir(),
): IpcSocketPathResolution {
  const maxPathBytes = getUnixSocketMaxPathBytes();
  const preferredPath = join(baseDir, socketFileName);

  if (isPathWithinSocketLimit(preferredPath, maxPathBytes)) {
    return {
      path: preferredPath,
      source: "protected",
      preferredPath,
      maxPathBytes,
    };
  }

  const tmpCandidate = buildTmpCandidate(preferredPath, socketFileName);
  if (isPathWithinSocketLimit(tmpCandidate.hashedPath, maxPathBytes)) {
    return {
      path: tmpCandidate.hashedPath,
      source: "tmp-hash",
      preferredPath,
      maxPathBytes,
    };
  }

  return {
    path: tmpCandidate.shortPath,
    source: "tmp-short-hash",
    preferredPath,
    maxPathBytes,
  };
}
