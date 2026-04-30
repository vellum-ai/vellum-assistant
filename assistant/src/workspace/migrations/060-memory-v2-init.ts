import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

const PROSE_FILES = ["essentials.md", "threads.md", "recent.md", "buffer.md"];

export const memoryV2InitMigration: WorkspaceMigration = {
  id: "060-memory-v2-init",
  description: "Seed memory/ directory for v2 memory subsystem",

  run(workspaceDir: string): void {
    const memoryDir = join(workspaceDir, "memory");
    mkdirSync(join(memoryDir, "concepts"), { recursive: true });
    mkdirSync(join(memoryDir, "archive"), { recursive: true });
    mkdirSync(join(memoryDir, ".v2-state"), { recursive: true });

    // Seed the prose files only if missing — preserves any user content from
    // manual setup or a prior migration.
    for (const filename of PROSE_FILES) {
      const filePath = join(memoryDir, filename);
      if (!existsSync(filePath)) {
        writeFileSync(filePath, "", "utf-8");
      }
    }
  },

  down(workspaceDir: string): void {
    // Remove `memory/.v2-state/` only — preserve the prose files for safety.
    // Users may have hand-edited essentials/threads/recent/buffer or generated
    // concept pages; we never delete those on a rollback.
    rmSync(join(workspaceDir, "memory", ".v2-state"), {
      recursive: true,
      force: true,
    });
  },
};
