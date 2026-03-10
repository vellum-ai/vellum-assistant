#!/usr/bin/env bun
/**
 * CLI entry point for the Amazon skill: `bun run scripts/amazon.ts`
 *
 * Shop on Amazon and Amazon Fresh via the command line.
 * All commands output JSON to stdout. Use --json for machine-readable output.
 */

import { parseArgs } from "node:util";

import {
  addToCart,
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
import { extractSessionFromChromeCookies } from "./headless-cookies.js";
import { clearSession, loadSession, saveSession } from "./session.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isJson = process.argv.includes("--json");

function output(data: unknown): void {
  process.stdout.write(
    isJson ? JSON.stringify(data) + "\n" : JSON.stringify(data, null, 2) + "\n",
  );
}

function outputError(message: string, code = 1): void {
  output({ ok: false, error: message });
  process.exitCode = code;
}

const SESSION_EXPIRED_MSG =
  "Your Amazon session has expired. Please sign in to Amazon in Chrome \u2014 " +
  "the assistant will use Ride Shotgun to capture your session automatically.";

async function run(fn: () => Promise<unknown>): Promise<void> {
  try {
    const result = await fn();
    output({ ok: true, ...(result as Record<string, unknown>) });
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      output({
        ok: false,
        error: "session_expired",
        message: SESSION_EXPIRED_MSG,
      });
      process.exitCode = 1;
      return;
    }
    outputError(err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

const USAGE = `amazon \u2014 Shop on Amazon and Amazon Fresh via the command line

All commands output JSON to stdout. Use --json for machine-readable output.

USAGE
  amazon <subcommand> [options]

SUBCOMMANDS
  status                          Check if an Amazon session is active
  logout                          Clear the saved Amazon session
  refresh                         Refresh session via Chrome browser extension
  refresh-headless                Refresh session from Chrome's local cookie database

  search <query>                  Search for products on Amazon
  product <asin>                  Get product details for an ASIN
  variations <asin>               List product variations (sizes, colors, etc.)

  cart view                       View cart contents
  cart add --asin <asin>          Add a product to the cart
  cart remove --cart-item-id <id> Remove an item from the cart

  fresh delivery-slots            Get available Amazon Fresh delivery slots
  fresh select-slot --slot-id <id>  Select an Amazon Fresh delivery slot

  payment-methods                 List saved payment methods
  checkout                        Get checkout summary (totals, shipping, payment)

  order place                     Place an Amazon order (IRREVERSIBLE)

GLOBAL OPTIONS
  --json        Machine-readable JSON output (compact, one line)
  --help, -h    Show this help message

SEARCH OPTIONS
  --fresh       Search Amazon Fresh grocery items
  --limit <n>   Max results (default: 20)

PRODUCT OPTIONS
  --fresh       Product is an Amazon Fresh item

CART ADD OPTIONS
  --asin <asin>       Required. Product ASIN
  --quantity <n>       Quantity (default: 1)
  --fresh              Amazon Fresh item
  --verbose            Show detailed diagnostics for debugging

CART REMOVE OPTIONS
  --cart-item-id <id>  Required. Cart item ID (from cart view)

FRESH SELECT-SLOT OPTIONS
  --slot-id <id>       Required. Delivery slot ID (from delivery-slots)

ORDER PLACE OPTIONS
  --payment-method-id <id>  Payment method ID (uses default if omitted)

EXAMPLES
  amazon status --json
  amazon refresh --json
  amazon search "AA batteries" --limit 5 --json
  amazon product B07XXXXX --json
  amazon cart add --asin B07XXXXX --quantity 2 --json
  amazon cart view --json
  amazon order place --json
`;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(USAGE);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Subcommand routing
// ---------------------------------------------------------------------------

const subcommand = process.argv[2];

switch (subcommand) {
  // =========================================================================
  // status
  // =========================================================================
  case "status": {
    await run(async () => {
      const session = await loadSession();
      if (session) {
        return { loggedIn: true, cookieCount: session.cookies.length };
      }
      return { loggedIn: false };
    });
    break;
  }

  // =========================================================================
  // logout
  // =========================================================================
  case "logout": {
    await run(async () => {
      await clearSession();
      return { message: "Session cleared" };
    });
    break;
  }

  // =========================================================================
  // refresh
  // =========================================================================
  case "refresh": {
    await run(async () => {
      const session = await refreshSessionFromExtension();
      return {
        message: "Session refreshed from Chrome via browser extension",
        cookieCount: session.cookies.length,
      };
    });
    break;
  }

  // =========================================================================
  // refresh-headless
  // =========================================================================
  case "refresh-headless": {
    await run(async () => {
      const session = await extractSessionFromChromeCookies();
      await saveSession(session);
      return {
        message: "Session refreshed from Chrome cookie database (headless)",
        cookieCount: session.cookies.length,
      };
    });
    break;
  }

  // =========================================================================
  // search
  // =========================================================================
  case "search": {
    const filteredArgs = process.argv.slice(3).filter((a) => a !== "--json");

    const { values, positionals } = parseArgs({
      args: filteredArgs,
      options: {
        fresh: { type: "boolean", default: false },
        limit: { type: "string", default: "20" },
      },
      allowPositionals: true,
    });

    const query = positionals[0];
    if (!query) {
      outputError("Missing required argument: <query>");
      break;
    }

    await run(async () => {
      const results = await search(query, {
        isFresh: values.fresh as boolean,
        limit: parseInt(values.limit as string, 10),
      });
      return { results, count: results.length };
    });
    break;
  }

  // =========================================================================
  // product
  // =========================================================================
  case "product": {
    const filteredArgs = process.argv.slice(3).filter((a) => a !== "--json");

    const { values, positionals } = parseArgs({
      args: filteredArgs,
      options: {
        fresh: { type: "boolean", default: false },
      },
      allowPositionals: true,
    });

    const asin = positionals[0];
    if (!asin) {
      outputError("Missing required argument: <asin>");
      break;
    }

    await run(async () => {
      const product = await getProductDetails(asin, {
        isFresh: values.fresh as boolean,
      });
      return { product };
    });
    break;
  }

  // =========================================================================
  // variations
  // =========================================================================
  case "variations": {
    const filteredArgs = process.argv.slice(3).filter((a) => a !== "--json");

    const { positionals } = parseArgs({
      args: filteredArgs,
      options: {},
      allowPositionals: true,
    });

    const asin = positionals[0];
    if (!asin) {
      outputError("Missing required argument: <asin>");
      break;
    }

    await run(async () => {
      const product = await getProductDetails(asin);
      return {
        asin,
        title: product.title,
        variations: product.variations,
        count: product.variations.length,
      };
    });
    break;
  }

  // =========================================================================
  // cart
  // =========================================================================
  case "cart": {
    const cartSubcommand = process.argv[3];

    switch (cartSubcommand) {
      case "view": {
        await run(async () => {
          const result = await viewCart();
          return { cart: result };
        });
        break;
      }

      case "add": {
        const filteredArgs = process.argv
          .slice(4)
          .filter((a) => a !== "--json");

        const { values } = parseArgs({
          args: filteredArgs,
          options: {
            asin: { type: "string" },
            quantity: { type: "string", default: "1" },
            fresh: { type: "boolean", default: false },
            verbose: { type: "boolean", default: false },
          },
          allowPositionals: true,
        });

        if (!values.asin) {
          outputError("Missing required option: --asin <asin>");
          break;
        }

        await run(async () => {
          const result = await addToCart({
            asin: values.asin as string,
            quantity: parseInt(values.quantity as string, 10),
            isFresh: values.fresh as boolean,
            verbose: values.verbose as boolean,
          });

          // Dump verbose diagnostics to stderr so they don't pollute JSON output
          if (values.verbose) {
            const v = (result as unknown as Record<string, unknown>).__verbose;
            if (v) {
              process.stderr.write(
                "\n[amazon:verbose] -- Cart Add Diagnostics --\n",
              );
              for (const [k, val] of Object.entries(
                v as Record<string, unknown>,
              )) {
                const icon = String(val) === "EMPTY" ? "X" : "OK";
                process.stderr.write(
                  `[amazon:verbose]   ${icon} ${k}: ${val}\n`,
                );
              }
              process.stderr.write(
                "[amazon:verbose] ----------------------------\n\n",
              );
            }
            const d = (result as unknown as Record<string, unknown>)
              .__debug as Record<string, unknown> | undefined;
            if (d?.addCartJson) {
              process.stderr.write(
                `[amazon:verbose] Raw Amazon response: ${d.addCartJson}\n\n`,
              );
            }
          }

          // Strip internal debug fields from JSON output unless verbose
          if (!values.verbose) {
            delete (result as unknown as Record<string, unknown>).__verbose;
            delete (result as unknown as Record<string, unknown>).__debug;
          }

          return { cart: result };
        });
        break;
      }

      case "remove": {
        const filteredArgs = process.argv
          .slice(4)
          .filter((a) => a !== "--json");

        const { values } = parseArgs({
          args: filteredArgs,
          options: {
            "cart-item-id": { type: "string" },
          },
          allowPositionals: true,
        });

        if (!values["cart-item-id"]) {
          outputError("Missing required option: --cart-item-id <id>");
          break;
        }

        await run(async () => {
          const result = await removeFromCart({
            cartItemId: values["cart-item-id"] as string,
          });
          return { cart: result };
        });
        break;
      }

      default: {
        process.stderr.write(
          cartSubcommand
            ? `Unknown cart subcommand: ${cartSubcommand}\n\n`
            : "No cart subcommand provided. Use: view, add, remove\n\n",
        );
        process.stderr.write(USAGE);
        process.exitCode = 1;
      }
    }
    break;
  }

  // =========================================================================
  // fresh
  // =========================================================================
  case "fresh": {
    const freshSubcommand = process.argv[3];

    switch (freshSubcommand) {
      case "delivery-slots": {
        await run(async () => {
          const slots = await getFreshDeliverySlots();
          return { slots, count: slots.length };
        });
        break;
      }

      case "select-slot": {
        const filteredArgs = process.argv
          .slice(4)
          .filter((a) => a !== "--json");

        const { values } = parseArgs({
          args: filteredArgs,
          options: {
            "slot-id": { type: "string" },
          },
          allowPositionals: true,
        });

        if (!values["slot-id"]) {
          outputError("Missing required option: --slot-id <id>");
          break;
        }

        await run(async () => {
          const result = await selectFreshDeliverySlot(
            values["slot-id"] as string,
          );
          return result;
        });
        break;
      }

      default: {
        process.stderr.write(
          freshSubcommand
            ? `Unknown fresh subcommand: ${freshSubcommand}\n\n`
            : "No fresh subcommand provided. Use: delivery-slots, select-slot\n\n",
        );
        process.stderr.write(USAGE);
        process.exitCode = 1;
      }
    }
    break;
  }

  // =========================================================================
  // payment-methods
  // =========================================================================
  case "payment-methods": {
    await run(async () => {
      const methods = await getPaymentMethods();
      return { methods, count: methods.length };
    });
    break;
  }

  // =========================================================================
  // checkout
  // =========================================================================
  case "checkout": {
    await run(async () => {
      const summary = await getCheckoutSummary();
      return { summary };
    });
    break;
  }

  // =========================================================================
  // order
  // =========================================================================
  case "order": {
    const orderSubcommand = process.argv[3];

    switch (orderSubcommand) {
      case "place": {
        const filteredArgs = process.argv
          .slice(4)
          .filter((a) => a !== "--json");

        const { values } = parseArgs({
          args: filteredArgs,
          options: {
            "payment-method-id": { type: "string" },
          },
          allowPositionals: true,
        });

        await run(async () => {
          const result = await placeOrder({
            paymentMethodId: values["payment-method-id"] as string | undefined,
          });
          return { order: result };
        });
        break;
      }

      default: {
        process.stderr.write(
          orderSubcommand
            ? `Unknown order subcommand: ${orderSubcommand}\n\n`
            : "No order subcommand provided. Use: place\n\n",
        );
        process.stderr.write(USAGE);
        process.exitCode = 1;
      }
    }
    break;
  }

  // =========================================================================
  // default — unknown or missing subcommand
  // =========================================================================
  default: {
    process.stderr.write(
      subcommand
        ? `Unknown subcommand: ${subcommand}\n\n`
        : "No subcommand provided.\n\n",
    );
    process.stderr.write(USAGE);
    process.exitCode = 1;
  }
}
