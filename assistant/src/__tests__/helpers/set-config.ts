/**
 * Shared test helper: seed workspace config for real instead of mocking
 * `config/loader`.
 *
 * Writes a top-level key into `$VELLUM_WORKSPACE_DIR/config.json`
 * (read-modify-write, so seeding several keys composes) and bumps the file
 * mtime monotonically so the loader's file-signature cache re-reads on the
 * next `getConfig()`/`getConfigReadOnly()`. The production loader
 * schema-merges the partial file over defaults — the same path a user's
 * config.json takes.
 *
 * Node stdlib only, per the test-machinery isolation rules.
 */
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let mtimeSeq = 0;

export function setConfig(key: string, value: unknown): void {
  const path = join(process.env.VELLUM_WORKSPACE_DIR!, "config.json");
  let config: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      // Unparseable prior seed — start fresh; the loader treats a corrupt
      // file as defaults anyway.
    }
  }
  config[key] = value;
  writeFileSync(path, JSON.stringify(config));
  // Force a distinct mtime per write so the loader's size+mtime+ctime
  // signature can never read two consecutive seeds as identical.
  mtimeSeq += 1;
  const stamp = new Date(Date.now() + mtimeSeq);
  utimesSync(path, stamp, stamp);
}
