/**
 * Simple read/write for session recording JSON files.
 * Inlined from assistant/src/tools/browser/recording-store.ts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { getDataDir } from "./platform.js";
import type { SessionRecording } from "./recording-types.js";

function getRecordingsDir(): string {
  return join(getDataDir(), "recordings");
}

export function saveRecording(recording: SessionRecording): string {
  const dir = getRecordingsDir();
  mkdirSync(dir, { recursive: true });

  const filePath = resolve(dir, `${recording.id}.json`);
  if (!filePath.startsWith(resolve(dir) + "/")) {
    throw new Error(`Invalid recording ID: ${recording.id}`);
  }
  writeFileSync(filePath, JSON.stringify(recording, null, 2), "utf-8");
  return filePath;
}

export function loadRecording(recordingId: string): SessionRecording | null {
  const dir = getRecordingsDir();
  const filePath = resolve(dir, `${recordingId}.json`);
  if (!filePath.startsWith(resolve(dir) + "/")) {
    return null;
  }
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const data = readFileSync(filePath, "utf-8");
    return JSON.parse(data) as SessionRecording;
  } catch {
    return null;
  }
}
