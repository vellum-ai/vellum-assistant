import { readFileSync, writeFileSync } from "node:fs";

import type { Command } from "commander";

import { getConfig } from "../../../config/loader.js";
import {
  type Services,
  ServicesSchema,
} from "../../../config/schemas/services.js";
import type { OAuthConnectionRequest } from "../../../oauth/connection.js";
import {
  resolveOAuthConnection,
  type ResolveOAuthConnectionOptions,
} from "../../../oauth/connection-resolver.js";
import {
  getActiveConnection,
  getAppByProviderAndClientId,
  getProvider,
} from "../../../oauth/oauth-store.js";
import { resolveService } from "../../../oauth/provider-behaviors.js";
import { VellumPlatformClient } from "../../../platform/client.js";
import { shouldOutputJson, writeOutput } from "../../output.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collect repeatable `-H` flags into an array. Commander's `.option()` with
 * a custom collect function accumulates values across repeated flags.
 */
function collectHeader(value: string, previous: string[]): string[] {
  return previous.concat(value);
}

/**
 * Parse a raw header string ("Key: Value") into a [key, value] tuple.
 * Splits on the first `:` only, so values may contain colons.
 */
function parseHeader(raw: string): [string, string] {
  const idx = raw.indexOf(":");
  if (idx === -1) {
    throw new Error(
      `Invalid header format: "${raw}". Expected "Key: Value" with a colon separator.`,
    );
  }
  return [raw.slice(0, idx).trim(), raw.slice(idx + 1).trim()];
}

/**
 * Attempt to JSON-parse a string. Returns the parsed value on success,
 * or the original string on failure.
 */
function tryJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Read body data from the `-d` flag value. Supports:
 * - `@-` reads stdin
 * - `@<path>` reads a file
 * - Otherwise treats as inline data
 *
 * All sources attempt JSON parse with fallback to raw string.
 */
function readBodyData(data: string): unknown {
  if (data === "@-") {
    // Read stdin synchronously. Bun supports readFileSync("/dev/stdin").
    const raw = readFileSync("/dev/stdin", "utf-8");
    return tryJsonParse(raw);
  }

  if (data.startsWith("@")) {
    const filePath = data.slice(1);
    const raw = readFileSync(filePath, "utf-8");
    return tryJsonParse(raw);
  }

  return tryJsonParse(data);
}

/**
 * Determine whether a provider is running in platform-managed mode.
 * Returns false if config is unavailable (e.g. in test environments).
 */
function isManagedMode(providerKey: string): boolean {
  const provider = getProvider(providerKey);
  const managedKey = provider?.managedServiceConfigKey;
  if (!managedKey || !(managedKey in ServicesSchema.shape)) return false;
  try {
    const services: Services = getConfig().services;
    return services[managedKey as keyof Services].mode === "managed";
  } catch {
    return false;
  }
}

/**
 * Normalize a bare provider name into the canonical provider key.
 */
function toBareProvider(provider: string): string {
  return provider.startsWith("integration:")
    ? provider.slice("integration:".length)
    : provider;
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerRequestCommand(oauth: Command): void {
  oauth
    .command("request <url>")
    .description(
      "Make an authenticated OAuth request (curl-like interface for LLM agents)",
    )
    .requiredOption(
      "--provider <key>",
      "Provider key (e.g. integration:google) or alias (e.g. gmail)",
    )
    .option("-X, --request <method>", "HTTP method (default: GET)")
    .option(
      "-H, --header <header>",
      "Request header (repeatable, format: 'Key: Value')",
      collectHeader,
      [] as string[],
    )
    .option(
      "-d, --data <data>",
      "Request body: inline JSON, @filename, or @- for stdin",
    )
    .option("-G, --get", "Force GET; body data becomes query params")
    .option("-I, --head", "Send a HEAD request")
    .option("-o, --output <file>", "Write response body to file")
    .option("-s, --silent", "Suppress informational stderr output")
    .option("-v, --verbose", "Show request/response details on stderr")
    .option("-i, --include", "Show response headers on stderr")
    .option("--account <account>", "Account identifier for multi-account")
    .option("--client-id <id>", "BYO app client ID disambiguation")
    .addHelpText(
      "after",
      `
Make authenticated HTTP requests through an OAuth provider. Resolves the
OAuth connection automatically (platform-managed or BYO) and injects
tokens transparently.

URL can be absolute (https://api.twitter.com/2/tweets) or relative (/2/tweets).
Absolute URLs have their host extracted as a baseUrl override; relative paths
use the provider's configured default.

Note: The Authorization header is set automatically. User-supplied
-H "Authorization: ..." will be overridden by the OAuth bearer token.

Examples:
  $ assistant oauth request --provider integration:twitter https://api.x.com/2/tweets
  $ assistant oauth request --provider gmail /gmail/v1/users/me/messages -G
  $ assistant oauth request --provider integration:twitter -X POST -d '{"text":"Hello"}' https://api.x.com/2/tweets
  $ assistant oauth request --provider integration:google -d @body.json https://www.googleapis.com/calendar/v3/calendars
  $ assistant oauth request --provider integration:slack -H "Content-Type: application/json" -d '{"channel":"C123"}' /api/chat.postMessage --json`,
    )
    .action(
      async (
        url: string,
        opts: {
          provider: string;
          request?: string;
          header: string[];
          data?: string;
          get?: boolean;
          head?: boolean;
          output?: string;
          silent?: boolean;
          verbose?: boolean;
          include?: boolean;
          account?: string;
          clientId?: string;
        },
        cmd: Command,
      ) => {
        const jsonMode = shouldOutputJson(cmd);

        // Helper: write an error and set exit code
        const writeError = (error: string, hint?: string): void => {
          if (jsonMode) {
            const payload: Record<string, unknown> = { ok: false, error };
            if (hint) payload.hint = hint;
            writeOutput(cmd, payload);
          } else {
            process.stderr.write(error + "\n");
          }
          process.exitCode = 1;
        };

        // Helper: write info to stderr (respects -s)
        const writeInfo = (msg: string): void => {
          if (!opts.silent) {
            process.stderr.write(msg + "\n");
          }
        };

        try {
          // -----------------------------------------------------------------
          // 1. Resolve provider key
          // -----------------------------------------------------------------
          const providerKey = resolveService(opts.provider);

          // -----------------------------------------------------------------
          // Pre-flight check 1: Provider not found
          // -----------------------------------------------------------------
          const providerRow = getProvider(providerKey);
          if (!providerRow) {
            writeError(
              `Error: Unknown provider "${providerKey}".\n\n` +
                `Run 'assistant oauth providers list' to see available providers.\n` +
                `If this is a custom provider, register it first with 'assistant oauth providers register --help'.`,
            );
            return;
          }

          // -----------------------------------------------------------------
          // Pre-flight check 2: Determine managed vs BYO mode
          // -----------------------------------------------------------------
          const managed = isManagedMode(providerKey);

          // -----------------------------------------------------------------
          // Pre-flight check 3: Client ID not found (BYO only)
          // -----------------------------------------------------------------
          if (opts.clientId) {
            if (managed) {
              writeInfo(
                `Warning: --client-id is ignored for platform-managed providers. The platform manages OAuth apps for "${providerKey}".`,
              );
            } else {
              const app = getAppByProviderAndClientId(
                providerKey,
                opts.clientId,
              );
              if (!app) {
                writeError(
                  `Error: No registered OAuth app found for "${providerKey}" with client ID "${opts.clientId}".\n\n` +
                    `Run 'assistant oauth apps list' to see registered apps for this provider.\n` +
                    `To register a new app, run 'assistant oauth apps upsert --help'.`,
                );
                return;
              }
            }
          }

          // -----------------------------------------------------------------
          // Pre-flight check 4: Account not found
          // -----------------------------------------------------------------
          if (opts.account) {
            if (managed) {
              // Query platform connections to validate account
              const client = await VellumPlatformClient.create();
              if (client && client.platformAssistantId) {
                const params = new URLSearchParams();
                params.set("provider", toBareProvider(providerKey));
                params.set("status", "ACTIVE");
                params.set("account_identifier", opts.account);

                const path = `/v1/assistants/${encodeURIComponent(client.platformAssistantId)}/oauth/connections/?${params.toString()}`;
                const response = await client.fetch(path);

                if (response.ok) {
                  const body = (await response.json()) as unknown;
                  const connections = (
                    Array.isArray(body)
                      ? body
                      : ((body as Record<string, unknown>).results ?? [])
                  ) as Array<{ id: string }>;

                  if (connections.length === 0) {
                    writeError(
                      `Error: No active platform connection found for "${providerKey}" with account "${opts.account}".\n\n` +
                        `Run 'assistant oauth platform status' to see connected accounts for this provider.\n` +
                        `To connect a new account, run 'assistant oauth platform connect --help'.`,
                    );
                    return;
                  }
                }
              }
            } else {
              const conn = getActiveConnection(providerKey, {
                clientId: opts.clientId,
                account: opts.account,
              });
              if (!conn) {
                writeError(
                  `Error: No active OAuth connection found for "${providerKey}" with account "${opts.account}"${opts.clientId ? ` and client ID "${opts.clientId}"` : ""}.\n\n` +
                    `Run 'assistant oauth connections list' to see active connections.\n` +
                    `To connect a new account, run 'assistant oauth connections connect --help'.`,
                );
                return;
              }
            }
          }

          // -----------------------------------------------------------------
          // Parse URL
          // -----------------------------------------------------------------
          let baseUrl: string | undefined;
          let requestPath: string;
          const queryFromUrl: Record<string, string> = {};

          if (url.startsWith("http://") || url.startsWith("https://")) {
            const parsed = new URL(url);
            baseUrl = `${parsed.protocol}//${parsed.host}`;
            requestPath = parsed.pathname;
            for (const [key, value] of parsed.searchParams.entries()) {
              queryFromUrl[key] = value;
            }
          } else {
            requestPath = url;
          }

          // -----------------------------------------------------------------
          // Parse headers
          // -----------------------------------------------------------------
          const headers: Record<string, string> = {};
          for (const raw of opts.header) {
            const [key, value] = parseHeader(raw);
            headers[key] = value;
          }

          // -----------------------------------------------------------------
          // Resolve method
          // -----------------------------------------------------------------
          let method: string;
          if (opts.head) {
            method = "HEAD";
          } else if (opts.request) {
            method = opts.request.toUpperCase();
          } else if (opts.get) {
            method = "GET";
          } else if (opts.data !== undefined) {
            method = "POST";
          } else {
            method = "GET";
          }

          // -----------------------------------------------------------------
          // Handle body / query params
          // -----------------------------------------------------------------
          let body: unknown = undefined;
          const query: Record<string, string | string[]> = { ...queryFromUrl };

          if (opts.data !== undefined) {
            const rawBody = readBodyData(opts.data);

            if (opts.get) {
              // With -G, body data becomes query params
              if (typeof rawBody === "string") {
                // Parse as URL-encoded query params
                const bodyParams = new URLSearchParams(rawBody);
                for (const [key, value] of bodyParams.entries()) {
                  query[key] = value;
                }
              } else if (
                rawBody !== null &&
                typeof rawBody === "object" &&
                !Array.isArray(rawBody)
              ) {
                for (const [key, value] of Object.entries(
                  rawBody as Record<string, unknown>,
                )) {
                  query[key] = String(value);
                }
              }
            } else {
              body = rawBody;
            }
          }

          // -----------------------------------------------------------------
          // Verbose: show request details
          // -----------------------------------------------------------------
          if (opts.verbose) {
            writeInfo(`> ${method} ${requestPath}`);
            for (const [key, value] of Object.entries(headers)) {
              writeInfo(`> ${key}: ${value}`);
            }
            if (baseUrl) {
              writeInfo(`> Host: ${baseUrl}`);
            }
            writeInfo(`> Authorization: Bearer [REDACTED]`);
            writeInfo(`>`);
          }

          // -----------------------------------------------------------------
          // Resolve connection and make request
          // -----------------------------------------------------------------
          const resolveOptions: ResolveOAuthConnectionOptions = {};
          if (opts.clientId && !managed) {
            resolveOptions.clientId = opts.clientId;
          }
          if (opts.account) {
            resolveOptions.account = opts.account;
          }

          let connection;
          try {
            connection = await resolveOAuthConnection(
              providerKey,
              resolveOptions,
            );
          } catch {
            // Error case 5: Connection resolution failure
            if (managed) {
              writeError(
                `Error: No active platform OAuth connection found for "${providerKey}".\n\n` +
                  `Run 'assistant oauth platform status' to check connection status.\n` +
                  `To connect, run 'assistant oauth platform connect --help'.`,
              );
            } else {
              writeError(
                `Error: No active OAuth connection found for "${providerKey}".\n\n` +
                  `Run 'assistant oauth connections list' to see active connections.\n` +
                  `To connect, run 'assistant oauth connections connect --help'.`,
              );
            }
            return;
          }

          const req: OAuthConnectionRequest = {
            method,
            path: requestPath,
            ...(Object.keys(query).length > 0 ? { query } : {}),
            ...(Object.keys(headers).length > 0 ? { headers } : {}),
            ...(body !== undefined ? { body } : {}),
            ...(baseUrl ? { baseUrl } : {}),
          };

          const response = await connection.request(req);

          // -----------------------------------------------------------------
          // Non-2xx exit code
          // -----------------------------------------------------------------
          if (response.status < 200 || response.status >= 300) {
            process.exitCode = 1;
          }

          // -----------------------------------------------------------------
          // Error case 6: Auth errors (401/403) — add diagnostic hint
          // -----------------------------------------------------------------
          let authHint: string | undefined;
          if (response.status === 401 || response.status === 403) {
            if (managed) {
              authHint =
                `Hint: Request returned HTTP ${response.status}. The OAuth token may be expired or revoked.\n\n` +
                `Run 'assistant oauth platform status --provider ${providerKey}' to check connection health.\n` +
                `To reconnect, run 'assistant oauth platform connect --help'.`;
            } else {
              authHint =
                `Hint: Request returned HTTP ${response.status}. The OAuth token may be expired or revoked.\n\n` +
                `Run 'assistant oauth connections list --provider-key ${providerKey}' to check connection status.\n` +
                `To reconnect, run 'assistant oauth connections connect --help'.`;
            }
            writeInfo(authHint);
          }

          // -----------------------------------------------------------------
          // Output: --json mode
          // -----------------------------------------------------------------
          if (jsonMode) {
            const payload: Record<string, unknown> = {
              ok: response.status >= 200 && response.status < 300,
              status: response.status,
              headers: response.headers,
              body: response.body,
            };
            if (authHint) {
              payload.hint = authHint;
            }
            writeOutput(cmd, payload);
            return;
          }

          // -----------------------------------------------------------------
          // Output: verbose / include — response headers to stderr
          // -----------------------------------------------------------------
          if (opts.verbose || opts.include) {
            writeInfo(`< HTTP ${response.status}`);
            for (const [key, value] of Object.entries(response.headers)) {
              writeInfo(`< ${key}: ${value}`);
            }
            writeInfo(`<`);
          }

          // -----------------------------------------------------------------
          // Output: body
          // -----------------------------------------------------------------
          const bodyStr =
            typeof response.body === "string"
              ? response.body
              : JSON.stringify(response.body, null, 2);

          if (opts.output) {
            writeFileSync(opts.output, bodyStr, "utf-8");
          } else {
            process.stdout.write(bodyStr + "\n");
          }
        } catch (err) {
          // Error case 7: Generic/unexpected errors
          const message = err instanceof Error ? err.message : String(err);

          // Try to extract providerKey for the generic hint
          let providerKey: string;
          try {
            providerKey = resolveService(opts.provider);
          } catch {
            providerKey = opts.provider;
          }

          writeError(
            `Error: ${message}\n\n` +
              `For provider diagnostics, run 'assistant oauth providers get ${providerKey}'.`,
          );
        }
      },
    );
}
