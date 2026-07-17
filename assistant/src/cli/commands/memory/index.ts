import type { Command } from "commander";

import { applyCommandHelp } from "../../lib/cli-command-help.js";
import { registerCommand } from "../../lib/register-command.js";
import { memoryHelp } from "./index.help.js";
import { registerMemoryItemsCommand } from "./items.js";
import { registerMemoryRetrospectiveCommand } from "./memory-retrospective.js";
import { registerMemoryV2Command } from "./memory-v2.js";
import { registerMemoryV3Command } from "./memory-v3.js";
import { registerMemoryNodesCommand } from "./nodes.js";
import { registerMemoryWorkerCommand } from "./worker.js";

export function registerMemoryCommand(program: Command): void {
  registerCommand(program, {
    name: memoryHelp.name,
    transport: "ipc",
    description: memoryHelp.description,
    build: (memory) => {
      applyCommandHelp(memory, memoryHelp);

      registerMemoryNodesCommand(memory);
      registerMemoryItemsCommand(memory);
      registerMemoryV2Command(memory);
      registerMemoryV3Command(memory);
      registerMemoryRetrospectiveCommand(memory);
      registerMemoryWorkerCommand(memory);
    },
  });
}
