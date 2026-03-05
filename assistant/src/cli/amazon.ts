/**
 * CLI command group: `vellum amazon`
 *
 * Shop on Amazon and Amazon Fresh via the command line.
 * All commands output JSON to stdout. Use --json for machine-readable output.
 */

import * as net from "node:net";

import { Command } from "commander";

import {
  addToCart,
  getCheckoutSummary,
  getFreshDeliverySlots,
  getPaymentMethods,
  getProductDetails,
  placeOrder,
  removeFromCart,
  search,
  selectFreshDeliverySlot,
  SessionExpiredError,
  viewCart,
} from "../amazon/client.js";
import { extractRequests, saveRequests } from "../amazon/request-extractor.js";
import {
  clearSession,
  importFromRecording,
  loadSession,
  saveSession,
} from "../amazon/session.js";
import { createMessageParser, serialize } from "../daemon/ipc-protocol.js";
import { loadRecording } from "../tools/browser/recording-store.js";
import { getSocketPath, readSessionToken } from "../util/platform.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function output(data: unknown, json: boolean): void {
  process.stdout.write(
    json ? JSON.stringify(data) + "\n" : JSON.stringify(data, null, 2) + "\n",
  );
}

function outputError(message: string, code = 1): void {
  output({ ok: false, error: message }, true);
  process.exitCode = code;
}

function getJson(cmd: Command): boolean {
  let c: Command | null = cmd;
  while (c) {
    if ((c.opts() as { json?: boolean }).json) return true;
    c = c.parent;
  }
  return false;
}

const SESSION_EXPIRED_MSG =
  "Your Amazon session has expired. Please sign in to Amazon in Chrome — " +
  "the assistant will use Ride Shotgun to capture your session automatically.";

async function run(cmd: Command, fn: () => Promise<unknown>): Promise<void> {
  try {
    const result = await fn();
    output({ ok: true, ...(result as Record<string, unknown>) }, getJson(cmd));
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      output(
        { ok: false, error: "session_expired", message: SESSION_EXPIRED_MSG },
        getJson(cmd),
      );
      process.exitCode = 1;
      return;
    }
    outputError(err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerAmazonCommand(program: Command): void {
  const amz = program
    .command("amazon")
    .description(
      "Shop on Amazon and Amazon Fresh. Requires a session imported from a Ride Shotgun recording.",
    )
    .option("--json", "Machine-readable JSON output");

  // =========================================================================
  // login — import session from a recording
  // =========================================================================
  amz
    .command("login")
    .description("Import an Amazon session from a Ride Shotgun recording")
    .requiredOption("--recording <path>", "Path to the recording JSON file")
    .action(async (opts: { recording: string }, cmd: Command) => {
      await run(cmd, async () => {
        const session = importFromRecording(opts.recording);
        return {
          message: "Session imported successfully",
          cookieCount: session.cookies.length,
          recordingId: session.recordingId,
        };
      });
    });

  // =========================================================================
  // logout — clear saved session
  // =========================================================================
  amz
    .command("logout")
    .description("Clear the saved Amazon session")
    .action((_opts: unknown, cmd: Command) => {
      clearSession();
      output({ ok: true, message: "Session cleared" }, getJson(cmd));
    });

  // =========================================================================
  // refresh — start Ride Shotgun learn to capture fresh cookies
  // =========================================================================
  amz
    .command("refresh")
    .description(
      "Start a Ride Shotgun learn session to capture fresh Amazon cookies. " +
        "Opens amazon.com in a separate Chrome window — sign in when prompted. " +
        "Your existing Chrome and tabs are not affected.",
    )
    .option("--duration <seconds>", "Recording duration in seconds", "180")
    .action(async (opts: { duration: string }, cmd: Command) => {
      const json = getJson(cmd);
      const duration = parseInt(opts.duration, 10);

      try {
        // Restore minimized Chrome window so user can see the login page
        try {
          await restoreChromeWindow();
        } catch {
          /* best-effort */
        }

        const result = await startLearnSession(duration);
        if (result.recordingPath) {
          const session = importFromRecording(result.recordingPath);

          // Also extract and save captured request templates for self-healing
          let requestsCaptured = 0;
          try {
            const recording = loadRecording(result.recordingId ?? "");
            if (recording) {
              const requests = extractRequests(recording);
              if (requests.length > 0) {
                saveRequests(requests);
                requestsCaptured = requests.length;
              }
            }
          } catch {
            // Non-fatal: request extraction is best-effort
          }

          // Best-effort: minimize Chrome window after capturing session
          try {
            await minimizeChromeWindow();
            process.stderr.write("[amazon] Chrome window minimized\n");
          } catch {
            // Non-fatal: minimizing is best-effort
          }

          output(
            {
              ok: true,
              message: "Session refreshed successfully",
              cookieCount: session.cookies.length,
              recordingId: result.recordingId,
              requestsCaptured,
            },
            json,
          );
        } else {
          output(
            {
              ok: false,
              error: "Recording completed but no recording path returned",
              recordingId: result.recordingId,
            },
            json,
          );
          process.exitCode = 1;
        }
      } catch (err) {
        outputError(err instanceof Error ? err.message : String(err));
      }
    });

  // =========================================================================
  // refresh-headless — refresh session from Chrome's cookie database
  // =========================================================================
  amz
    .command("refresh-headless")
    .description(
      "Refresh Amazon session by reading cookies directly from Chrome's local database. " +
        "No visible Chrome window needed. Requires Chrome to be signed into Amazon.",
    )
    .action(async (_opts: unknown, cmd: Command) => {
      const json = getJson(cmd);
      try {
        const session = await extractSessionFromChromeCookies();
        saveSession(session);
        output(
          {
            ok: true,
            message: "Session refreshed from Chrome cookie database (headless)",
            cookieCount: session.cookies.length,
          },
          json,
        );
      } catch (err) {
        outputError(err instanceof Error ? err.message : String(err));
      }
    });

  // =========================================================================
  // status — check session status
  // =========================================================================
  amz
    .command("status")
    .description("Check if an Amazon session is active")
    .action((_opts: unknown, cmd: Command) => {
      const session = loadSession();
      if (session) {
        output(
          {
            ok: true,
            loggedIn: true,
            cookieCount: session.cookies.length,
            importedAt: session.importedAt,
            recordingId: session.recordingId,
          },
          getJson(cmd),
        );
      } else {
        output({ ok: true, loggedIn: false }, getJson(cmd));
      }
    });

  // =========================================================================
  // search — search for products
  // =========================================================================
  amz
    .command("search")
    .description("Search for products on Amazon")
    .argument("<query>", 'Search query (e.g. "AA batteries", "milk")')
    .option("--fresh", "Search Amazon Fresh grocery items")
    .option("--limit <n>", "Max results", "20")
    .action(
      async (
        query: string,
        opts: { fresh?: boolean; limit: string },
        cmd: Command,
      ) => {
        await run(cmd, async () => {
          const results = await search(query, {
            isFresh: opts.fresh,
            limit: parseInt(opts.limit, 10),
          });
          return { results, count: results.length };
        });
      },
    );

  // =========================================================================
  // product — get product details
  // =========================================================================
  amz
    .command("product")
    .description("Get product details for an ASIN")
    .argument("<asin>", "Amazon ASIN (e.g. B07XXXXX)")
    .option("--fresh", "Product is an Amazon Fresh item")
    .action(async (asin: string, opts: { fresh?: boolean }, cmd: Command) => {
      await run(cmd, async () => {
        const product = await getProductDetails(asin, { isFresh: opts.fresh });
        return { product };
      });
    });

  // =========================================================================
  // variations — list product variations (child ASINs)
  // =========================================================================
  amz
    .command("variations")
    .description(
      "List available variations (sizes, colors, etc.) for a product",
    )
    .argument("<asin>", "Parent ASIN")
    .action(async (asin: string, _opts: unknown, cmd: Command) => {
      await run(cmd, async () => {
        const product = await getProductDetails(asin);
        return {
          asin,
          title: product.title,
          variations: product.variations,
          count: product.variations.length,
        };
      });
    });

  // =========================================================================
  // cart — cart operations (subcommand group)
  // =========================================================================
  const cart = amz.command("cart").description("Cart operations");

  // cart view
  cart
    .command("view")
    .description("View cart contents")
    .action(async (_opts: unknown, cmd: Command) => {
      await run(cmd, async () => {
        const result = await viewCart();
        return { cart: result };
      });
    });

  // cart add
  cart
    .command("add")
    .description("Add a product to the cart")
    .requiredOption("--asin <asin>", "Product ASIN")
    .option("--quantity <n>", "Quantity", "1")
    .option("--fresh", "Amazon Fresh item")
    .option("--verbose", "Show detailed diagnostics for debugging")
    .action(
      async (
        opts: {
          asin: string;
          quantity: string;
          fresh?: boolean;
          verbose?: boolean;
        },
        cmd: Command,
      ) => {
        await run(cmd, async () => {
          const result = await addToCart({
            asin: opts.asin,
            quantity: parseInt(opts.quantity, 10),
            isFresh: opts.fresh,
            verbose: opts.verbose,
          });
          // Dump verbose diagnostics to stderr so they don't pollute JSON output
          if (opts.verbose) {
            const v = (result as unknown as Record<string, unknown>).__verbose;
            if (v) {
              process.stderr.write(
                "\n[amazon:verbose] ── Cart Add Diagnostics ──\n",
              );
              for (const [k, val] of Object.entries(
                v as Record<string, unknown>,
              )) {
                const icon = String(val) === "EMPTY" ? "❌" : "✅";
                process.stderr.write(
                  `[amazon:verbose]   ${icon} ${k}: ${val}\n`,
                );
              }
              process.stderr.write(
                "[amazon:verbose] ──────────────────────────\n\n",
              );
            }
            const d = (result as unknown as Record<string, unknown>).__debug as
              | Record<string, unknown>
              | undefined;
            if (d?.addCartJson) {
              process.stderr.write(
                `[amazon:verbose] Raw Amazon response: ${d.addCartJson}\n\n`,
              );
            }
          }
          // Strip internal debug fields from JSON output unless verbose
          if (!opts.verbose) {
            delete (result as unknown as Record<string, unknown>).__verbose;
            delete (result as unknown as Record<string, unknown>).__debug;
          }
          return { cart: result };
        });
      },
    );

  // cart remove
  cart
    .command("remove")
    .description("Remove an item from the cart")
    .requiredOption("--cart-item-id <id>", "Cart item ID (from cart view)")
    .action(async (opts: { cartItemId: string }, cmd: Command) => {
      await run(cmd, async () => {
        const result = await removeFromCart({ cartItemId: opts.cartItemId });
        return { cart: result };
      });
    });

  // =========================================================================
  // fresh — Amazon Fresh operations (subcommand group)
  // =========================================================================
  const fresh = amz
    .command("fresh")
    .description("Amazon Fresh grocery delivery operations");

  // fresh delivery-slots
  fresh
    .command("delivery-slots")
    .description("Get available Amazon Fresh delivery slots")
    .action(async (_opts: unknown, cmd: Command) => {
      await run(cmd, async () => {
        const slots = await getFreshDeliverySlots();
        return { slots, count: slots.length };
      });
    });

  // fresh select-slot
  fresh
    .command("select-slot")
    .description("Select an Amazon Fresh delivery slot")
    .requiredOption(
      "--slot-id <id>",
      "Delivery slot ID (from delivery-slots command)",
    )
    .action(async (opts: { slotId: string }, cmd: Command) => {
      await run(cmd, async () => {
        const result = await selectFreshDeliverySlot(opts.slotId);
        return result;
      });
    });

  // =========================================================================
  // payment-methods — list saved payment methods
  // =========================================================================
  amz
    .command("payment-methods")
    .description("List saved payment methods")
    .action(async (_opts: unknown, cmd: Command) => {
      await run(cmd, async () => {
        const methods = await getPaymentMethods();
        return { methods, count: methods.length };
      });
    });

  // =========================================================================
  // checkout — get checkout summary
  // =========================================================================
  amz
    .command("checkout")
    .description("Get checkout summary (totals, shipping, payment options)")
    .action(async (_opts: unknown, cmd: Command) => {
      await run(cmd, async () => {
        const summary = await getCheckoutSummary();
        return { summary };
      });
    });

  // =========================================================================
  // order — order operations (subcommand group)
  // =========================================================================
  const order = amz.command("order").description("Order operations");

  // order place
  order
    .command("place")
    .description(
      "Place an Amazon order (IRREVERSIBLE — always confirm with user first)",
    )
    .option(
      "--payment-method-id <id>",
      "Payment method ID (uses default if omitted)",
    )
    .option("--slot-id <id>", "Amazon Fresh delivery slot ID")
    .action(
      async (
        opts: { paymentMethodId?: string; slotId?: string },
        cmd: Command,
      ) => {
        await run(cmd, async () => {
          const result = await placeOrder({
            paymentMethodId: opts.paymentMethodId,
            deliverySlotId: opts.slotId,
          });
          return { order: result };
        });
      },
    );
}

// ---------------------------------------------------------------------------
// Chrome CDP helpers (delegated to shared module)
// ---------------------------------------------------------------------------

import { execSync } from "node:child_process";
import * as crypto from "node:crypto";
import {
  copyFileSync,
  existsSync as fileExists,
  unlinkSync as unlinkFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join as pathJoin } from "node:path";

import {
  ensureChromeWithCdp,
  minimizeChromeWindow,
  restoreChromeWindow,
} from "../tools/browser/chrome-cdp.js";

// ---------------------------------------------------------------------------
// Headless cookie extraction from Chrome's SQLite database
// ---------------------------------------------------------------------------

const CHROME_COOKIES_DB = pathJoin(
  homedir(),
  "Library/Application Support/Google/Chrome/Default/Cookies",
);

/**
 * Decrypt a Chrome cookie encrypted_value blob on macOS.
 * Chrome uses AES-128-CBC with a key derived from the Keychain password via PBKDF2.
 * The encrypted blob is prefixed with 'v10' (3 bytes).
 */
function decryptChromeCookie(
  encHex: string,
  derivedKey: Buffer,
): string | null {
  const buf = Buffer.from(encHex, "hex");
  if (buf.length < 4 || buf.slice(0, 3).toString() !== "v10") return null;
  try {
    const iv = Buffer.alloc(16, 0x20); // Chrome uses 16 space characters as IV
    const decipher = crypto.createDecipheriv("aes-128-cbc", derivedKey, iv);
    const decrypted = Buffer.concat([
      decipher.update(buf.slice(3)),
      decipher.final(),
    ]);
    // Strip leading non-printable bytes (padding artifacts)
    const str = decrypted.toString("utf-8");
    const match = str.match(/[\x20-\x7e]+/);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

/**
 * Extract Amazon session cookies directly from Chrome's local SQLite cookie database.
 * No visible Chrome window or user interaction required.
 *
 * Requirements:
 *   - Chrome must be installed with a Default profile
 *   - The user must be signed into Amazon in Chrome
 *   - macOS Keychain access for 'Chrome Safe Storage' (will prompt once)
 */
async function extractSessionFromChromeCookies(): Promise<
  import("../amazon/session.js").AmazonSession
> {
  // 1. Get Chrome Safe Storage key from macOS Keychain
  let keychainPassword: string;
  try {
    keychainPassword = execSync(
      'security find-generic-password -w -s "Chrome Safe Storage" -a "Chrome"',
      { encoding: "utf-8" },
    ).trim();
  } catch {
    throw new Error(
      "Could not read Chrome Safe Storage key from macOS Keychain. " +
        "Make sure Chrome is installed and has been opened at least once.",
    );
  }

  // 2. Derive the AES key using PBKDF2 (same as Chrome's implementation)
  const derivedKey = crypto.pbkdf2Sync(
    keychainPassword,
    "saltysalt",
    1003,
    16,
    "sha1",
  );

  // 3. Copy the Cookies DB to a temp file, then query the copy.
  //    Reading Chrome's live SQLite DB directly can interfere with Chrome's
  //    WAL journaling and cause session logouts. Copying first is safe.
  const tmpCookiesDb = pathJoin(
    tmpdir(),
    `vellum-chrome-cookies-${Date.now()}.db`,
  );
  let rawOutput: string;
  try {
    copyFileSync(CHROME_COOKIES_DB, tmpCookiesDb);
    // Also copy WAL and SHM files if they exist, so the copy is consistent
    const walPath = CHROME_COOKIES_DB + "-wal";
    const shmPath = CHROME_COOKIES_DB + "-shm";
    if (fileExists(walPath)) copyFileSync(walPath, tmpCookiesDb + "-wal");
    if (fileExists(shmPath)) copyFileSync(shmPath, tmpCookiesDb + "-shm");

    rawOutput = execSync(
      `sqlite3 "${tmpCookiesDb}" "SELECT name, hex(encrypted_value), host_key, path, is_httponly, is_secure, expires_utc FROM cookies WHERE host_key LIKE '%amazon.com%'"`,
      { encoding: "utf-8" },
    ).trim();
  } catch {
    throw new Error(
      "Could not read Chrome Cookies database. " +
        "Make sure Chrome is installed and the Cookies file exists.",
    );
  } finally {
    // Clean up temp files
    try {
      unlinkFileSync(tmpCookiesDb);
    } catch {}
    try {
      unlinkFileSync(tmpCookiesDb + "-wal");
    } catch {}
    try {
      unlinkFileSync(tmpCookiesDb + "-shm");
    } catch {}
  }

  if (!rawOutput) {
    throw new Error(
      "No Amazon cookies found in Chrome. " +
        "Make sure you are signed into Amazon in Chrome.",
    );
  }

  // 4. Decrypt each cookie
  const cookies: import("../tools/browser/network-recording-types.js").ExtractedCredential[] =
    [];
  for (const line of rawOutput.split("\n")) {
    const parts = line.split("|");
    if (parts.length < 7) continue;
    const [name, encHex, domain, path, httpOnly, secure, expiresUtc] = parts;
    if (!encHex) continue;

    const value = decryptChromeCookie(encHex, derivedKey);
    if (!value) continue;

    cookies.push({
      name,
      value,
      domain,
      path: path || "/",
      httpOnly: httpOnly === "1",
      secure: secure === "1",
      expires: expiresUtc
        ? Math.floor(parseInt(expiresUtc, 10) / 1000000 - 11644473600)
        : undefined,
    });
  }

  // 5. Validate required cookies are present
  const cookieNames = new Set(cookies.map((c) => c.name));
  if (!cookieNames.has("session-id")) {
    throw new Error(
      "Chrome cookies are missing required Amazon cookie: session-id. " +
        "Make sure you are signed into Amazon in Chrome.",
    );
  }
  if (!cookieNames.has("ubid-main")) {
    throw new Error(
      "Chrome cookies are missing required Amazon cookie: ubid-main. " +
        "Make sure you are signed into Amazon in Chrome.",
    );
  }
  if (!cookieNames.has("at-main") && !cookieNames.has("x-main")) {
    throw new Error(
      "Chrome cookies are missing required Amazon auth cookie (at-main or x-main). " +
        "Make sure you are fully signed into Amazon in Chrome.",
    );
  }

  return {
    cookies,
    importedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Ride Shotgun learn session helper
// ---------------------------------------------------------------------------

interface LearnResult {
  recordingId?: string;
  recordingPath?: string;
}

async function startLearnSession(
  durationSeconds: number,
): Promise<LearnResult> {
  await ensureChromeWithCdp({ startUrl: "https://www.amazon.com/" });

  return new Promise((resolve, reject) => {
    const socketPath = getSocketPath();
    const sessionToken = readSessionToken();
    const socket = net.createConnection(socketPath);
    const parser = createMessageParser();

    socket.on("error", (err) => {
      reject(
        new Error(
          `Cannot connect to assistant: ${err.message}. Is the assistant running?`,
        ),
      );
    });

    const timeoutHandle = setTimeout(
      () => {
        socket.destroy();
        reject(
          new Error(`Learn session timed out after ${durationSeconds + 30}s`),
        );
      },
      (durationSeconds + 30) * 1000,
    );
    timeoutHandle.unref();

    let authenticated = !sessionToken;

    const sendStartCommand = () => {
      socket.write(
        serialize({
          type: "ride_shotgun_start",
          durationSeconds,
          intervalSeconds: 5,
          mode: "learn",
          targetDomain: "amazon.com",
        } as unknown as import("../daemon/ipc-protocol.js").ClientMessage),
      );
    };

    socket.on("data", (chunk) => {
      const messages = parser.feed(chunk.toString("utf-8"));
      for (const msg of messages) {
        const m = msg as unknown as Record<string, unknown>;

        if (!authenticated && m.type === "auth_result") {
          if ((m as { success: boolean }).success) {
            authenticated = true;
            sendStartCommand();
          } else {
            clearTimeout(timeoutHandle);
            socket.destroy();
            reject(new Error("Authentication failed"));
          }
          continue;
        }

        if (m.type === "auth_result") {
          continue;
        }

        if (m.type === "ride_shotgun_result") {
          clearTimeout(timeoutHandle);
          socket.destroy();
          resolve({
            recordingId: m.recordingId as string | undefined,
            recordingPath: m.recordingPath as string | undefined,
          });
        }
      }
    });

    socket.on("connect", () => {
      if (sessionToken) {
        socket.write(
          serialize({
            type: "auth",
            token: sessionToken,
          } as unknown as import("../daemon/ipc-protocol.js").ClientMessage),
        );
      } else {
        sendStartCommand();
      }
    });
  });
}
