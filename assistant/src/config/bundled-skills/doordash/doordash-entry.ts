#!/usr/bin/env bun
/**
 * Standalone DoorDash CLI entry point.
 *
 * Invoked via the launcher script at ~/.vellum/bin/doordash,
 * which is created when the doordash skill is installed.
 */

import { Command } from 'commander';

import { registerDoordashCommand } from './doordash-cli.js';

const program = new Command();
program.name('doordash').description('Order food from DoorDash');
registerDoordashCommand(program);
program.parse();
