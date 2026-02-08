#!/usr/bin/env node

import { up } from './commands/up.js';
import { down } from './commands/down.js';
import { setup } from './commands/setup.js';
import { ps } from './commands/ps.js';
import { help } from './commands/help.js';

const commands = {
  up,
  down,
  setup,
  ps,
  help,
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
