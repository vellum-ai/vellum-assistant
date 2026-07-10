import type { Command } from "commander";

import { registerCommand } from "../../lib/register-command.js";
import { registerMemoryItemsCommand } from "./items.js";
import { registerMemoryRetrospectiveCommand } from "./memory-retrospective.js";
import { registerMemoryV2Command } from "./memory-v2.js";
import { registerMemoryV3Command } from "./memory-v3.js";
import { registerMemoryNodesCommand } from "./nodes.js";
import { registerMemoryWorkerCommand } from "./worker.js";

export function registerMemoryCommand(program: Command): void {
  registerCommand(program, {
    name: "memory",
    transport: "ipc",
    description:
      "Manage memory items and maintain the assistant memory subsystem",
    build: (memory) => {
      memory.addHelpText(
        "after",
        `
The 'nodes' subgroup provides content-based list, delete, and update over
memory v2 graph nodes — address facts by text, not UUID (requires memory v2).

The 'items' subgroup exposes full CRUD over individual memory items
(remembered facts) — list, get, create, update, delete.

The memory subsystem retrieves concept pages two ways: the v2 concept-page
activation model (prose pages with directed edges) and the v3 section-lane
model (section-grain lanes cached as live shadow state). Each subgroup exposes
operator-facing maintenance verbs — reindexing, backfills, validation, and evals.

Examples:
  $ assistant memory nodes list --search "coffee"
  $ assistant memory nodes delete "User prefers TypeScript"
  $ assistant memory nodes update "User prefers TypeScript" "User prefers TypeScript and Bun"
  $ assistant memory items list --search "coffee"
  $ assistant memory items update 9f2c4f3a-3f1a-41e4-88e7-abc123 --statement "Prefers tea"
  $ assistant memory items delete 9f2c4f3a-3f1a-41e4-88e7-abc123
  $ assistant memory v2 validate
  $ assistant memory v3 rebuild-index`,
      );

      registerMemoryNodesCommand(memory);
      registerMemoryItemsCommand(memory);
      registerMemoryV2Command(memory);
      registerMemoryV3Command(memory);
      registerMemoryRetrospectiveCommand(memory);
      registerMemoryWorkerCommand(memory);
    },
  });
}
