#!/usr/bin/env bun

import { Command } from "commander";

import pkg from "../package.json";
import { registerListCommands } from "./commands/list";
import { registerRunCommand } from "./commands/run";
import { registerServerCommand } from "./commands/server";

const program = new Command();
program
  .name("evals")
  .description("Vellum Personal-Intelligence Benchmark harness")
  .version(pkg.version);

registerListCommands(program);
registerRunCommand(program);
registerServerCommand(program);

await program.parseAsync(process.argv);
