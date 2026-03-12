import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

const MAX_ENTRIES = 1000;

function historyPath(): string {
  return join(homedir(), ".vellum", "input-history");
}

export function loadHistory(): string[] {
  try {
    const path = historyPath();
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
    const path = historyPath();
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
