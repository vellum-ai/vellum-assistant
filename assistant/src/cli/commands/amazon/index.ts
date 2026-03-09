/**
 * CLI command group: `assistant amazon`
 *
 * Shop on Amazon and Amazon Fresh via the command line.
 * All commands output JSON to stdout. Use --json for machine-readable output.
 */

import { Command } from "commander";

import {
  addToCart,
  type ExtractedCredential,
  getCheckoutSummary,
  getFreshDeliverySlots,
  getPaymentMethods,
  getProductDetails,
  placeOrder,
  refreshSessionFromExtension,
  removeFromCart,
  search,
  selectFreshDeliverySlot,
  SessionExpiredError,
  viewCart,
} from "./client.js";
import {
  clearSession,
  importFromRecording,
  loadSession,
  saveSession,
} from "./session.js";

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

  amz.addHelpText(
    "after",
    `
Amazon shopping is powered by session cookies captured via Ride Shotgun.
A valid session must be established before any shopping commands will work.

Session lifecycle:
  1. "refresh" opens Chrome and captures cookies via a Ride Shotgun learn session.
     The user must sign into Amazon when prompted. Existing Chrome tabs are unaffected.
  2. "refresh-headless" reads cookies directly from Chrome's local SQLite database.
     No visible browser window is needed, but Chrome must already be signed into Amazon.
  3. "status" checks whether a valid session exists.
  4. "login" imports a session from a previously saved Ride Shotgun recording file.
  5. "logout" clears the saved session.

Product workflow: search for products, view details/variations by ASIN, then add
to cart. Use --fresh flag for Amazon Fresh grocery items throughout the workflow.

Cart and checkout: add/remove items, view cart, get checkout summary, list payment
methods, and place an order. For Amazon Fresh orders, select a delivery slot first.

WARNING: "order place" is IRREVERSIBLE — it charges the user's payment method and
places a real Amazon order. Always confirm with the user before running it.

Examples:
  $ assistant amazon status
  $ assistant amazon refresh
  $ assistant amazon search "AA batteries" --limit 5
  $ assistant amazon cart add --asin B07XXXXX --quantity 2
  $ assistant amazon order place --payment-method-id pm_abc123`,
  );

  // =========================================================================
  // login — import session from a recording
  // =========================================================================
  amz
    .command("login")
    .description("Import an Amazon session from a Ride Shotgun recording")
    .requiredOption("--recording <path>", "Path to the recording JSON file")
    .addHelpText(
      "after",
      `
Imports Amazon session cookies from a previously saved Ride Shotgun recording
file. The recording must contain captured cookies from an authenticated Amazon
session. Typically used to restore a session from a saved recording rather than
re-authenticating via "refresh".

Examples:
  $ assistant amazon login --recording /path/to/recording.json
  $ assistant amazon login --recording ~/recordings/amazon-2024-01-15.json`,
    )
    .action(async (opts: { recording: string }, cmd: Command) => {
      await run(cmd, async () => {
        const session = await importFromRecording(opts.recording);
        return {
          message: "Session imported successfully",
          cookieCount: session.cookies.length,
        };
      });
    });

  // =========================================================================
  // logout — clear saved session
  // =========================================================================
  amz
    .command("logout")
    .description("Clear the saved Amazon session")
    .addHelpText(
      "after",
      `
Removes all saved Amazon session cookies from local storage. After logout,
all shopping commands will fail until a new session is established via
"refresh", "refresh-headless", or "login".

Examples:
  $ assistant amazon logout`,
    )
    .action(async (_opts: unknown, cmd: Command) => {
      await clearSession();
      output({ ok: true, message: "Session cleared" }, getJson(cmd));
    });

  // =========================================================================
  // refresh — grab Amazon cookies from Chrome via browser extension
  // =========================================================================
  amz
    .command("refresh")
    .description(
      "Refresh Amazon session by grabbing cookies from Chrome via the browser extension. " +
        "Requires the Vellum Chrome extension to be loaded and connected.",
    )
    .addHelpText(
      "after",
      `
Grabs Amazon session cookies directly from Chrome via the browser extension
relay. Much faster than the old Ride Shotgun approach — no separate Chrome
instance is launched. Requires the Vellum Chrome extension to be loaded
and connected.

If this fails, try "refresh-headless" which reads cookies from Chrome's
local SQLite database instead.

Examples:
  $ assistant amazon refresh
  $ assistant amazon refresh --json`,
    )
    .action(async (_opts: unknown, cmd: Command) => {
      const json = getJson(cmd);
      try {
        const session = await refreshSessionFromExtension();
        output(
          {
            ok: true,
            message: "Session refreshed from Chrome via browser extension",
            cookieCount: session.cookies.length,
          },
          json,
        );
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
    .addHelpText(
      "after",
      `
Reads Amazon session cookies directly from Chrome's local SQLite cookie
database (~/Library/Application Support/Google/Chrome/Default/Cookies).
No visible Chrome window or user interaction is required.

Requirements:
  - Chrome must be installed with a Default profile
  - The user must already be signed into Amazon in Chrome
  - macOS Keychain access for "Chrome Safe Storage" (may prompt once)

The cookie database is copied to a temp file before reading to avoid
interfering with Chrome's WAL journaling. Required cookies (session-id,
ubid-main, and at-main or x-main) are validated after extraction.

Examples:
  $ assistant amazon refresh-headless
  $ assistant amazon refresh-headless --json`,
    )
    .action(async (_opts: unknown, cmd: Command) => {
      const json = getJson(cmd);
      try {
        const session = await extractSessionFromChromeCookies();
        await saveSession(session);
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
    .addHelpText(
      "after",
      `
Reports whether an Amazon session is currently stored locally. If a session
exists, returns the cookie count. If no session exists, returns loggedIn: false.

Use this to verify session health before running shopping commands.

Examples:
  $ assistant amazon status
  $ assistant amazon status --json`,
    )
    .action(async (_opts: unknown, cmd: Command) => {
      const session = await loadSession();
      if (session) {
        output(
          {
            ok: true,
            loggedIn: true,
            cookieCount: session.cookies.length,
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
    .addHelpText(
      "after",
      `
Arguments:
  query   Free-text search query (e.g. "AA batteries", "organic milk").
          Wrap multi-word queries in quotes.

Searches Amazon product listings and returns matching results with ASINs,
titles, prices, and ratings. Use the returned ASINs with "product" or
"cart add" commands.

The --fresh flag restricts results to Amazon Fresh grocery items. The
--limit flag controls the maximum number of results returned (default: 20).

Examples:
  $ assistant amazon search "AA batteries"
  $ assistant amazon search "whole milk" --fresh --limit 10
  $ assistant amazon search "USB-C cable" --limit 5 --json`,
    )
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
    .addHelpText(
      "after",
      `
Arguments:
  asin   Amazon Standard Identification Number (e.g. B07XXXXX). Obtain
         ASINs from search results or product URLs.

Returns detailed product information including title, price, availability,
description, images, and available variations. Use --fresh if the product
is an Amazon Fresh grocery item.

Examples:
  $ assistant amazon product B07XXXXX
  $ assistant amazon product B08YYYYY --fresh
  $ assistant amazon product B07XXXXX --json`,
    )
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
    .addHelpText(
      "after",
      `
Arguments:
  asin   Parent ASIN to list variations for. Returns child ASINs
         representing different sizes, colors, styles, or configurations.

Fetches the product and returns its available variations (child ASINs).
Each variation includes dimension labels (e.g. "Size: Large", "Color: Blue")
and its own ASIN for use with "product" or "cart add".

Examples:
  $ assistant amazon variations B07XXXXX
  $ assistant amazon variations B07XXXXX --json`,
    )
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

  cart.addHelpText(
    "after",
    `
Manage the Amazon shopping cart. Items are identified by ASIN when adding
and by cart-item-id when removing (cart-item-id is returned by "cart view").

The cart is shared between regular Amazon and Amazon Fresh items. Use
--fresh when adding grocery items to route them through the Fresh workflow.

Examples:
  $ assistant amazon cart view
  $ assistant amazon cart add --asin B07XXXXX --quantity 2
  $ assistant amazon cart remove --cart-item-id CXYZ123`,
  );

  // cart view
  cart
    .command("view")
    .description("View cart contents")
    .addHelpText(
      "after",
      `
Returns all items currently in the cart, including ASIN, title, quantity,
price, and cart-item-id. Use the cart-item-id with "cart remove" to delete
individual items.

Examples:
  $ assistant amazon cart view
  $ assistant amazon cart view --json`,
    )
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
    .addHelpText(
      "after",
      `
Adds a product to the Amazon cart by ASIN.

Options:
  --asin <asin>      Required. The product ASIN to add (from search or product details).
  --quantity <n>     Number of units to add (default: 1).
  --fresh            Flag the item as an Amazon Fresh grocery product. Required for
                     Fresh items to route through the correct add-to-cart workflow.
  --verbose          Print detailed diagnostics to stderr for debugging add-to-cart
                     failures. Includes raw Amazon API response data.

Examples:
  $ assistant amazon cart add --asin B07XXXXX
  $ assistant amazon cart add --asin B08YYYYY --quantity 3 --fresh
  $ assistant amazon cart add --asin B07XXXXX --verbose`,
    )
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
    .addHelpText(
      "after",
      `
Removes a single item from the cart by its cart-item-id.

Options:
  --cart-item-id <id>   Required. The cart item identifier returned by "cart view".
                        This is NOT the product ASIN — it is Amazon's internal cart
                        line-item ID.

Examples:
  $ assistant amazon cart remove --cart-item-id CXYZ123
  $ assistant amazon cart remove --cart-item-id CXYZ123 --json`,
    )
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

  fresh.addHelpText(
    "after",
    `
Amazon Fresh grocery delivery management. Before placing a Fresh order, a
delivery slot must be selected. Use "delivery-slots" to list available time
windows, then "select-slot" to reserve one.

Fresh items must also be added to cart with the --fresh flag:
  $ assistant amazon cart add --asin B08YYYYY --fresh

Examples:
  $ assistant amazon fresh delivery-slots
  $ assistant amazon fresh select-slot --slot-id slot_abc123`,
  );

  // fresh delivery-slots
  fresh
    .command("delivery-slots")
    .description("Get available Amazon Fresh delivery slots")
    .addHelpText(
      "after",
      `
Lists available Amazon Fresh delivery time windows. Each slot includes a
slot ID, date, time range, and availability status. Use the slot ID with
"fresh select-slot" to reserve a delivery window before placing an order.

Slot availability changes frequently. Re-check before placing an order if
significant time has passed since the last query.

Examples:
  $ assistant amazon fresh delivery-slots
  $ assistant amazon fresh delivery-slots --json`,
    )
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
    .addHelpText(
      "after",
      `
Reserves an Amazon Fresh delivery slot for the current order. The slot ID
must be obtained from "fresh delivery-slots". A slot must be selected before
placing an Amazon Fresh order via "order place".

Examples:
  $ assistant amazon fresh select-slot --slot-id slot_abc123
  $ assistant amazon fresh select-slot --slot-id slot_abc123 --json`,
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
    .addHelpText(
      "after",
      `
Lists all payment methods saved on the user's Amazon account. Each method
includes a payment-method-id, type (credit card, debit, etc.), and a
masked description. Use the payment-method-id with "order place" to select
a specific payment method.

If no --payment-method-id is passed to "order place", Amazon uses the
account's default payment method.

Examples:
  $ assistant amazon payment-methods
  $ assistant amazon payment-methods --json`,
    )
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
    .addHelpText(
      "after",
      `
Retrieves the checkout summary without placing an order. Returns item
totals, shipping cost, tax, estimated delivery dates, selected payment
method, and shipping address.

Use this to review the order before committing with "order place". This
command is read-only and does not charge or modify the cart.

Examples:
  $ assistant amazon checkout
  $ assistant amazon checkout --json`,
    )
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

  order.addHelpText(
    "after",
    `
Order management commands. Currently supports placing orders.

WARNING: "order place" is IRREVERSIBLE. It charges the user's payment
method and submits a real Amazon order that cannot be undone via this CLI.
Always confirm with the user and review checkout summary first.

Examples:
  $ assistant amazon checkout
  $ assistant amazon order place`,
  );

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
    .addHelpText(
      "after",
      `
*** IRREVERSIBLE *** This command places a real Amazon order. It charges the
user's payment method and cannot be cancelled or undone through this CLI.
Always review "checkout" output and get explicit user confirmation first.

Options:
  --payment-method-id <id>   Payment method to charge. Obtain IDs from
                             "payment-methods". If omitted, Amazon uses the
                             account's default payment method.

For Amazon Fresh orders, select a delivery slot before placing the order:
  $ assistant amazon fresh select-slot --slot-id slot_abc123

Recommended workflow before placing an order:
  1. assistant amazon cart view          (verify cart contents)
  2. assistant amazon checkout           (review totals and shipping)
  3. Confirm with the user
  4. assistant amazon order place

Examples:
  $ assistant amazon order place
  $ assistant amazon order place --payment-method-id pm_abc123
  $ assistant amazon order place --json`,
    )
    .action(async (opts: { paymentMethodId?: string }, cmd: Command) => {
      await run(cmd, async () => {
        const result = await placeOrder({
          paymentMethodId: opts.paymentMethodId,
        });
        return { order: result };
      });
    });
}

// ---------------------------------------------------------------------------
// Headless cookie extraction from Chrome's SQLite database
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
  import("./session.js").AmazonSession
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
  const cookies: ExtractedCredential[] = [];
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
  };
}
