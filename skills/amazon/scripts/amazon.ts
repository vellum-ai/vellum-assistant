#!/usr/bin/env bun
/**
 * Standalone Amazon CLI entry point.
 *
 * Invoked via the launcher script at ~/.vellum/bin/amazon,
 * which is created when the amazon skill is installed.
 *
 * registerAmazonCommand() creates a nested `amazon` subcommand.
 * We extract that subcommand and use it as the root so
 * `bun run scripts/amazon.ts status` works directly.
 */

import { Command } from "commander";

import { registerAmazonCommand } from "./amazon-cli.js";

// Register into a throwaway parent, then extract the nested command
const wrapper = new Command();
registerAmazonCommand(wrapper);
const amz = wrapper.commands.find((c) => c.name() === "amazon");
if (!amz) throw new Error("amazon command not registered");
amz.parse();
