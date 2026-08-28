import { readFileSync, writeFileSync } from "node:fs";

import type { Command } from "commander";

import { exitFromIpcResult } from "../../../ipc/cli-client.js";
import {
  findContentTypeHeader,
  parseRequestBodyBytes,
  parseRequestBodyData,
} from "../../../util/oauth-request-body.js";
import { readStdinBytesSync } from "../../../util/read-stdin.js";
import { subcommand } from "../../lib/cli-command-help.js";
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
 * Read body data from the `-d` flag value. Supports:
 * - `@-` reads stdin
 * - `@<path>` reads a file
 * - Otherwise treats as inline data
 *
 * File/stdin reading must happen on the CLI side (not the daemon)
 * since stdin is attached to the CLI process and file paths are
 * relative to the user's cwd.
 *
 * A non-JSON `Content-Type` keeps the payload as the exact string the caller
 * gave, so multipart, XML, and form-encoded bodies reach the provider
 * unchanged. Files and stdin are read as raw bytes: valid UTF-8 stays text
 * (or JSON), and anything else travels as a Buffer.
 */
export function readBodyData(
  data: string,
  headers: Record<string, string>,
): unknown {
  const contentType = findContentTypeHeader(headers);

  if (data === "@-") {
    return parseRequestBodyBytes(readStdinBytesSync(), contentType);
  }

  if (data.startsWith("@")) {
    const filePath = data.slice(1);
    return parseRequestBodyBytes(readFileSync(filePath), contentType);
  }

  return parseRequestBodyData(data, contentType);
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerRequestCommand(oauth: Command): void {
  // Options are registered imperatively (not in index.help.ts): the
  // repeatable "-H, --header" flag needs a Commander collect parser
  // (function + array default) that the declarative help contract cannot
  // express, and option order around it must be preserved for help output.
  subcommand(oauth, "request")
    .requiredOption("--provider <key>", "Provider name (e.g. google, slack)")
    .option("-X, --request <method>", "HTTP method (default: GET)")
    .option(
      "-H, --header <header>",
      "Request header (repeatable, format: 'Key: Value')",
      collectHeader,
      [] as string[],
    )
    .option(
      "-d, --data <data>",
      "Request body: inline JSON, @filename, or @- for stdin. Sent raw when Content-Type is not JSON. Files keep their original bytes, including binary",
    )
    .option("-G, --get", "Force GET; body data becomes query params")
    .option("-I, --head", "Send a HEAD request")
    .option("-o, --output <file>", "Write response body to file")
    .option("-s, --silent", "Suppress informational stderr output")
    .option("-v, --verbose", "Show request/response details on stderr")
    .option("-i, --include", "Show response headers on stderr")
    .option("--account <account>", "Account identifier for multi-account")
    .option("--client-id <id>", "BYO app client ID disambiguation")
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
            if (hint) {
              payload.hint = hint;
            }
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
          // Parse headers for verbose output (before sending to daemon)
          const parsedHeaders: Record<string, string> = {};
          for (const raw of opts.header) {
            const [key, value] = parseHeader(raw);
            parsedHeaders[key] = value;
          }

          // Verbose: show request details
          if (opts.verbose) {
            const method = opts.head
              ? "HEAD"
              : opts.request
                ? opts.request.toUpperCase()
                : opts.get
                  ? "GET"
                  : opts.data !== undefined
                    ? "POST"
                    : "GET";
            writeInfo(`> ${method} ${url}`);
            for (const [key, value] of Object.entries(parsedHeaders)) {
              writeInfo(`> ${key}: ${value}`);
            }
            writeInfo(`> Authorization: Bearer [REDACTED]`);
            writeInfo(`>`);
          }

          // Read body data on the CLI side (file/stdin reading must happen here)
          let parsedData: unknown;
          if (opts.data !== undefined) {
            parsedData = readBodyData(opts.data, parsedHeaders);
          }

          const body: Record<string, unknown> = {
            provider: opts.provider,
            url,
          };
          if (opts.request) {
            body.method = opts.request;
          }
          if (Object.keys(parsedHeaders).length > 0) {
            body.headers = parsedHeaders;
          }
          if (parsedData !== undefined) {
            body.parsed_data = parsedData;
          }
          if (opts.get) {
            body.force_get = true;
          }
          if (opts.head) {
            body.head = true;
          }
          if (opts.account) {
            body.account = opts.account;
          }
          if (opts.clientId) {
            body.client_id = opts.clientId;
          }

          // Run the route handler in this process so Gmail-sized fetch and
          // JSON parse stay off the assistant event loop.
          const { handleRequest } =
            await import("../../../runtime/routes/oauth-commands-routes.js");
          const { RouteError } =
            await import("../../../runtime/routes/errors.js");

          let result: {
            ok: boolean;
            status: number;
            headers: Record<string, string>;
            body: unknown;
            bodyEncoding?: "base64";
            hint?: string;
            account?: string | null;
            accountWarning?: string;
          };
          try {
            result = (await handleRequest({ body })) as typeof result;
          } catch (err) {
            if (err instanceof RouteError) {
              return exitFromIpcResult({
                ok: false,
                error: err.message,
                statusCode: err.statusCode,
              });
            }
            throw err;
          }

          // Non-2xx exit code
          if (result.status < 200 || result.status >= 300) {
            process.exitCode = 1;
          }

          // Which account served the request, and any multi-account ambiguity.
          if (result.account) {
            writeInfo(`* Account: ${result.account}`);
          }
          if (result.accountWarning) {
            writeInfo(result.accountWarning);
          }

          // Auth hint
          if (result.hint) {
            writeInfo(result.hint);
          }

          // JSON output mode
          if (jsonMode) {
            writeOutput(cmd, result);
            return;
          }

          // Verbose / include — response headers to stderr
          if (opts.verbose || opts.include) {
            writeInfo(`< HTTP ${result.status}`);
            for (const [key, value] of Object.entries(result.headers)) {
              writeInfo(`< ${key}: ${value}`);
            }
            writeInfo(`<`);
          }

          // Body output (skip for null bodies: HEAD requests, 204, etc.)
          if (result.body != null || result.bodyEncoding === "base64") {
            const { materializeOAuthRequestOutput } =
              await import("../../../oauth/connection.js");
            const output = materializeOAuthRequestOutput(result);
            if (output) {
              if (opts.output) {
                writeFileSync(opts.output, output.bytes);
              } else {
                process.stdout.write(output.bytes);
                if (!output.isBinary) {
                  process.stdout.write("\n");
                }
              }
            }
          } else if (opts.output) {
            writeFileSync(opts.output, Buffer.alloc(0));
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeError(
            `Error: ${message}\n\n` +
              `For provider diagnostics, run 'assistant oauth providers get ${opts.provider}'.`,
          );
        }
      },
    );
}
