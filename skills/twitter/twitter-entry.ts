#!/usr/bin/env bun
/**
 * Standalone X (Twitter) CLI entry point.
 *
 * Invoked via the launcher script at ~/.vellum/bin/twitter,
 * which is created when the twitter skill is installed.
 *
 * registerTwitterCommand() creates a nested `x` subcommand
 * (designed for `vellum x <sub>`). We extract that subcommand
 * and use it as the root so `twitter status` works directly.
 */

import { Command } from 'commander';

import { registerTwitterCommand } from './twitter-cli.js';

// Register into a throwaway parent, then extract the nested command
const wrapper = new Command();
registerTwitterCommand(wrapper);
const tw = wrapper.commands.find((c) => c.name() === 'x');
if (!tw) throw new Error('x command not registered');
tw.parse();
