import type { Command } from "commander";

import { API_KEY_PROVIDERS } from "../config/loader.js";
import {
  deleteSecureKey,
  getSecureKey,
  setSecureKey,
} from "../security/secure-keys.js";
import { getCliLogger } from "../util/logger.js";

const log = getCliLogger("cli");

export function registerKeysCommand(program: Command): void {
  const keys = program
    .command("keys")
    .description("Manage API keys in secure storage");

  keys
    .command("list")
    .description("List all stored API key names")
    .action(() => {
      const stored: string[] = [];
      for (const provider of API_KEY_PROVIDERS) {
        const value = getSecureKey(provider);
        if (value) stored.push(provider);
      }
      if (stored.length === 0) {
        log.info("No API keys stored");
      } else {
        for (const name of stored) {
          log.info(`  ${name}`);
        }
      }
    });

  keys
    .command("set <provider> <key>")
    .description("Store an API key (e.g. vellum keys set anthropic sk-ant-...)")
    .action((provider: string, key: string) => {
      if (setSecureKey(provider, key)) {
        log.info(`Stored API key for "${provider}"`);
      } else {
        log.error(`Failed to store API key for "${provider}"`);
        process.exit(1);
      }
    });

  keys
    .command("delete <provider>")
    .description("Delete a stored API key")
    .action((provider: string) => {
      if (deleteSecureKey(provider)) {
        log.info(`Deleted API key for "${provider}"`);
      } else {
        log.error(`No API key found for "${provider}"`);
        process.exit(1);
      }
    });
}
