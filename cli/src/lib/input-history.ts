import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";

import { getInputHistoryPath } from "./environments/paths.js";

const MAX_ENTRIES = 1000;

export function loadHistory(): string[] {
  try {
    const path = getInputHistoryPath();
    if (!existsSync(path)) return [];
    const content = readFileSync(path, "utf-8");
    return content
      .split("\n")
      .filter((line) => line.length > 0)
      .slice(-MAX_ENTRIES);
  } catch {
    return [];
  }
}

export function appendHistory(entry: string): void {
  const trimmed = entry.trim();
  if (!trimmed || trimmed.startsWith("/")) return;
  try {
    const path = getInputHistoryPath();
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const existing = loadHistory();
    // Deduplicate: remove previous occurrence of the same entry
    const deduped = existing.filter((e) => e !== trimmed);
    deduped.push(trimmed);
    // Keep only the last MAX_ENTRIES
    const trimmedList = deduped.slice(-MAX_ENTRIES);
    writeFileSync(path, trimmedList.join("\n") + "\n", { mode: 0o600 });
  } catch {
    // Best-effort persistence — don't crash on write failure
  }
}
