import type { Command } from "commander";

import { API_KEY_PROVIDERS } from "../../config/loader.js";
import { credentialKey } from "../../security/credential-key.js";
import { getSecureKeyAsync } from "../../security/secure-keys.js";
import {
  deleteSecureKeyViaDaemon,
  setSecureKeyViaDaemon,
} from "../lib/daemon-credential-client.js";
import { log } from "../logger.js";

// ---------------------------------------------------------------------------
// CES shell lockdown guard
// ---------------------------------------------------------------------------

/**
 * Returns true when the current process is running inside an untrusted shell
 * (CES shell lockdown active). CLI commands that store or delete API keys
 * must check this and fail deterministically.
 */
function isUntrustedShell(): boolean {
  return process.env.VELLUM_UNTRUSTED_SHELL === "1";
}

/** Error message for commands blocked by CES shell lockdown. */
const UNTRUSTED_SHELL_ERROR =
  "This command is not available in untrusted shell mode. " +
  "API key management is restricted when running under CES shell lockdown.";

export function registerKeysCommand(program: Command): void {
  const keys = program
    .command("keys")
    .description("Manage API keys in secure storage");

  keys.addHelpText(
    "after",
    `
Keys are stored in secure local storage and are never written to disk in
plaintext. Each key is identified by provider name.

Known providers: ${API_KEY_PROVIDERS.join(", ")}

Examples:
  $ assistant keys list
  $ assistant keys set anthropic sk-ant-...
  $ assistant keys delete openai`,
  );

  keys
    .command("list")
    .description("List all stored API key names")
    .addHelpText(
      "after",
      `
Checks each known provider (${API_KEY_PROVIDERS.join(", ")}) and prints the
names of providers that have a stored key. Providers without a stored key are
omitted from the output.

Examples:
  $ assistant keys list`,
    )
    .action(async () => {
      const stored: string[] = [];
      for (const provider of API_KEY_PROVIDERS) {
        const value =
          (await getSecureKeyAsync(credentialKey(provider, "api_key"))) ??
          (await getSecureKeyAsync(provider));
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
    .description(
      "Store an API key (e.g. assistant keys set anthropic sk-ant-...)",
    )
    .addHelpText(
      "after",
      `
Arguments:
  provider   Provider name (e.g. anthropic, openai, gemini)
  key        The API key value to store

If a key already exists for the given provider, it is silently overwritten.

Examples:
  $ assistant keys set anthropic sk-ant-abc123
  $ assistant keys set openai sk-proj-xyz789
  $ assistant keys set fireworks fw-abc123`,
    )
    .action(async (provider: string, key: string) => {
      // CES shell lockdown: deny key storage in untrusted shells.
      if (isUntrustedShell()) {
        log.error(UNTRUSTED_SHELL_ERROR);
        process.exit(1);
      }

      const setResult = await setSecureKeyViaDaemon("api_key", provider, key);
      if (setResult.ok) {
        log.info(`Stored API key for "${provider}"`);
      } else {
        const detail = setResult.error ? `: ${setResult.error}` : "";
        log.error(`Failed to store API key for "${provider}"${detail}`);
        process.exit(1);
      }
    });

  keys
    .command("delete <provider>")
    .description("Delete a stored API key")
    .addHelpText(
      "after",
      `
Arguments:
  provider   Provider name whose key should be removed from secure storage

Removes the API key for the given provider from secure local storage. If
no key exists for the provider, exits with an error.

Examples:
  $ assistant keys delete openai
  $ assistant keys delete anthropic`,
    )
    .action(async (provider: string) => {
      // CES shell lockdown: deny key deletion in untrusted shells.
      if (isUntrustedShell()) {
        log.error(UNTRUSTED_SHELL_ERROR);
        process.exit(1);
      }

      const delResult = await deleteSecureKeyViaDaemon("api_key", provider);
      if (delResult.result === "deleted") {
        log.info(`Deleted API key for "${provider}"`);
      } else if (delResult.result === "error") {
        const detail = delResult.error ? `: ${delResult.error}` : "";
        log.error(`Failed to delete API key for "${provider}"${detail}`);
        process.exit(1);
      } else {
        log.error(`No API key found for "${provider}"`);
        process.exit(1);
      }
    });
}
