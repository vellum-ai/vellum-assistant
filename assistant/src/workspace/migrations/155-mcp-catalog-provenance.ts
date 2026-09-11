import {
  closeSync,
  fchmodSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

export const mcpCatalogProvenanceMigration: WorkspaceMigration = {
  id: "155-mcp-catalog-provenance",
  description: "Preserve existing MCP connections as custom integrations",
  run(workspaceDir) {
    const path = join(workspaceDir, "config.json");
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      if (
        error instanceof SyntaxError ||
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return;
    }
    const mcp = raw.mcp as { servers?: unknown } | null | undefined;
    const servers = mcp?.servers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
      return;
    }
    let changed = false;
    for (const server of Object.values(servers)) {
      if (
        server &&
        typeof server === "object" &&
        !Array.isArray(server) &&
        !Object.hasOwn(server, "catalog")
      ) {
        server.catalog = null;
        changed = true;
      }
    }
    if (changed) {
      const temporary = `${path}.migration-155.tmp`;
      const mode = statSync(path).mode & 0o777;
      const fd = openSync(temporary, "w", mode);
      try {
        fchmodSync(fd, mode);
        writeFileSync(fd, `${JSON.stringify(raw, null, 2)}\n`);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, path);
    }
  },
  retryFailedCheckpoint: true,
  down() {},
};
