#!/usr/bin/env bun
/**
 * Standalone DoorDash CLI entry point.
 *
 * Invoked via the launcher script at ~/.vellum/bin/doordash,
 * which is created when the doordash skill is installed.
 *
 * registerDoordashCommand() creates a nested `doordash` subcommand
 * (designed for `vellum doordash <sub>`). We extract that subcommand
 * and use it as the root so `doordash status` works directly.
 */

import { Command } from "commander@13.1.0";

import { registerDoordashCommand } from "./doordash-cli.js";

// Register into a throwaway parent, then extract the nested command
const wrapper = new Command();
registerDoordashCommand(wrapper);
const dd = wrapper.commands.find((c) => c.name() === "doordash");
if (!dd) throw new Error("doordash command not registered");
dd.parse();
