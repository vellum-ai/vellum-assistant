#!/usr/bin/env bun

import { Command } from "commander";

import pkg from "../package.json";
import { registerRunCommand } from "./commands/run";

const program = new Command();
program
  .name("evals")
  .description("Vellum Personal-Intelligence Benchmark harness")
  .version(pkg.version);

registerRunCommand(program);

await program.parseAsync(process.argv);
