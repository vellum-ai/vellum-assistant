#!/usr/bin/env bun

import { Command } from "commander";

import pkg from "../package.json";
import { registerListCommands } from "./commands/list";
import { registerExportCommand } from "./commands/export";
import { registerRunCommand } from "./commands/run";
import { registerServerCommand } from "./commands/server";

const program = new Command();
program
  .name("evals")
  .description("Vellum Personal-Intelligence Benchmark harness")
  .version(pkg.version);

registerListCommands(program);
registerExportCommand(program);
registerRunCommand(program);
registerServerCommand(program);

await program.parseAsync(process.argv);
