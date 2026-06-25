import type { Command } from "commander";

import { registerCommand } from "../../lib/register-command.js";
import { registerMemoryRetrospectiveCommand } from "./memory-retrospective.js";
import { registerMemoryV2Command } from "./memory-v2.js";
import { registerMemoryV3Command } from "./memory-v3.js";
import { registerMemoryWorkerCommand } from "./worker.js";

export function registerMemoryCommand(program: Command): void {
  registerCommand(program, {
    name: "memory",
    transport: "ipc",
    description: "Inspect and maintain the assistant memory subsystem",
    build: (memory) => {
      memory.addHelpText(
        "after",
        `
The memory subsystem retrieves concept pages two ways: the v2 concept-page
activation model (prose pages with directed edges) and the v3 section-lane
model (section-grain lanes cached as live shadow state). Each subgroup exposes
operator-facing maintenance verbs — reindexing, backfills, validation, and evals.

Examples:
  $ assistant memory v2 validate
  $ assistant memory v3 rebuild-index`,
      );

      registerMemoryV2Command(memory);
      registerMemoryV3Command(memory);
      registerMemoryRetrospectiveCommand(memory);
      registerMemoryWorkerCommand(memory);
    },
  });
}
