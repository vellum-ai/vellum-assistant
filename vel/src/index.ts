#!/usr/bin/env node

import { down } from './commands/down.js';
import { help } from './commands/help.js';
import { ps } from './commands/ps.js';
import { setup } from './commands/setup.js';
import { shell } from './commands/shell.js';
import { up } from './commands/up.js';

const commands = {
  down,
  help,
  ps,
  setup,
  shell,
  up,
} as const;

type CommandName = keyof typeof commands;

async function main() {
  const args = process.argv.slice(2);
  const commandName = args[0];

  if (!commandName || commandName === 'help' || commandName === '--help' || commandName === '-h') {
    help();
    process.exit(0);
  }

  const command = commands[commandName as CommandName];

  if (!command) {
    console.error(`Error: Unknown command '${commandName}'`);
    console.error('');
    help();
    process.exit(1);
  }

  try {
    await command();
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
