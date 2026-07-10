import { createRequire } from "node:module";

import type { Command } from "commander";

import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";

const loadModule = createRequire(import.meta.url);

/**
 * Loaded lazily because the provider catalog pulls the full model/TTS/STT
 * graphs. Sync require rather than import(): commander invokes help-text
 * callbacks synchronously, so there is no place to await a module load.
 */
function apiKeyProviders(): readonly string[] {
  const { API_KEY_PROVIDERS } = loadModule(
    "../../providers/provider-secret-catalog.js",
  ) as typeof import("../../providers/provider-secret-catalog.js");
  return API_KEY_PROVIDERS;
}

export function registerKeysCommand(program: Command): void {
  registerCommand(program, {
    name: "keys",
    transport: "local",
    description: "Manage API keys in secure storage",
    build: (keys) => {
      keys.addHelpText(
        "after",
        () => `
Keys are stored in secure local storage and are never written to disk in
plaintext. Each key is identified by provider name.

Known providers: ${apiKeyProviders().join(", ")}

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
          () => `
Checks each known provider (${apiKeyProviders().join(", ")}) and prints the
names of providers that have a stored key. Providers without a stored key are
omitted from the output.

Examples:
  $ assistant keys list`,
        )
        .action(async () => {
          const [{ credentialKey }, { getSecureKeyAsync }] = await Promise.all([
            import("../../security/credential-key.js"),
            import("../../security/secure-keys.js"),
          ]);
          const stored: string[] = [];
          for (const provider of apiKeyProviders()) {
            const value =
              (await getSecureKeyAsync(credentialKey(provider, "api_key"))) ??
              (await getSecureKeyAsync(provider));
            if (value) {
              stored.push(provider);
            }
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
          const { setSecureKeyViaDaemon } =
            await import("../lib/daemon-credential-client.js");
          const setResult = await setSecureKeyViaDaemon(
            "api_key",
            provider,
            key,
          );
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
          const { deleteSecureKeyViaDaemon } =
            await import("../lib/daemon-credential-client.js");
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
    },
  });
}
