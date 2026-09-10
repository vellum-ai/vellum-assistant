import { existsSync, statfsSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { StreamingValidationError } from "./vbundle-streaming-validator.js";

const IMPORT_HEADROOM_BYTES = 2 * 1024 ** 3;
export const MAX_BUNDLE_ENTRIES = 100_000;

/** Staging must coexist with the live workspace until the atomic swap. */
export function getImportByteBudget(workspaceDir: string): number {
  let path = resolve(workspaceDir);
  while (!existsSync(path) && dirname(path) !== path) {
    path = dirname(path);
  }
  const stats = statfsSync(path);
  return Math.max(0, stats.bavail * stats.bsize - IMPORT_HEADROOM_BYTES);
}

export function assertBundleFits(sizeBytes: number, maxBytes: number): void {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes > maxBytes) {
    throw new StreamingValidationError(
      "bundle_too_large",
      `Bundle requires ${sizeBytes} bytes. The destination allows ${maxBytes} bytes. Reduce the data or increase destination storage before retrying.`,
    );
  }
}
