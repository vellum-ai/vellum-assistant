/**
 * CLI command group: `vellum doordash`
 *
 * Order food from DoorDash via the command line.
 * All commands output JSON to stdout. Use --json for machine-readable output.
 */

import { statSync } from "node:fs";
import { join } from "node:path";

import { Command } from "commander";

import {
  ensureChromeWithCdp,
  minimizeChromeWindow,
  restoreChromeWindow,
} from "../../../tools/browser/chrome-cdp.js";
import {
  addToCart,
  getDropoffOptions,
  getItemDetails,
  getPaymentMethods,
  getStoreMenu,
  listCarts,
  placeOrder,
  removeFromCart,
  retailSearch,
  search,
  searchItems,
  SessionExpiredError,
  viewCart,
} from "./lib/client.js";
import { extractQueries, saveQueries } from "./lib/query-extractor.js";
import {
  clearSession,
  importFromRecording,
  loadSession,
} from "./lib/session.js";
import { NetworkRecorder } from "./lib/shared/network-recorder.js";
import { buildDaemonUrl, getDataDir, getHttpPort, readHttpToken } from "./lib/shared/platform.js";
import { loadRecording, saveRecording } from "./lib/shared/recording-store.js";
import type { SessionRecording } from "./lib/shared/recording-types.js";

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
  "Your DoorDash session has expired. Please sign in to DoorDash in Chrome — " +
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

export function registerDoordashCommand(program: Command): void {
  const dd = program
    .command("doordash")
    .description(
      "Order food from DoorDash. Requires a session imported from a Ride Shotgun recording.",
    )
    .option("--json", "Machine-readable JSON output");

  // =========================================================================
  // login — import session from a recording
  // =========================================================================
  dd.command("login")
    .description("Import a DoorDash session from a Ride Shotgun recording")
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
  dd.command("logout")
    .description("Clear the saved DoorDash session")
    .action((_opts: unknown, cmd: Command) => {
      clearSession();
      output({ ok: true, message: "Session cleared" }, getJson(cmd));
    });

  // =========================================================================
  // refresh — start Ride Shotgun learn to capture fresh cookies
  // =========================================================================
  dd.command("refresh")
    .description(
      "Start a Ride Shotgun learn session to capture fresh DoorDash cookies. " +
        "Opens doordash.com in a separate Chrome window — sign in when prompted. " +
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

          // Also extract and save captured queries for self-healing
          let queriesCaptured = 0;
          try {
            const recording = loadRecording(result.recordingId ?? "");
            if (recording) {
              const queries = extractQueries(recording);
              if (queries.length > 0) {
                saveQueries(queries);
                queriesCaptured = queries.length;
              }
            }
          } catch {
            // Non-fatal: query extraction is best-effort
          }

          // Best-effort: minimize Chrome window after capturing session
          try {
            await minimizeChromeWindow();
            process.stderr.write("[doordash] Chrome window minimized\n");
          } catch {
            // Non-fatal: minimizing is best-effort
          }

          output(
            {
              ok: true,
              message: "Session refreshed successfully",
              cookieCount: session.cookies.length,
              recordingId: result.recordingId,
              queriesCaptured,
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
  // record — standalone CDP network recording
  // =========================================================================
  dd.command("record")
    .description(
      "Record DoorDash network traffic via CDP. " +
        "Opens Chrome with CDP debugging, captures GraphQL operations, " +
        "and saves captured queries for self-healing API support.",
    )
    .option("--duration <seconds>", "Max recording duration in seconds", "120")
    .option(
      "--stop-on <operationName>",
      "Auto-stop when this GraphQL operation is captured (e.g. addCartItem)",
    )
    .action(
      async (opts: { duration: string; stopOn?: string }, cmd: Command) => {
        const json = getJson(cmd);
        const duration = parseInt(opts.duration, 10);

        try {
          const cdp = await ensureChromeWithCdp({
            startUrl: "https://www.doordash.com",
          });

          const startTime = Date.now() / 1000;
          const recorder = new NetworkRecorder("doordash.com");
          await recorder.startDirect(cdp.baseUrl);

          process.stderr.write("Recording DoorDash network traffic...\n");
          if (opts.stopOn) {
            process.stderr.write(
              `Will auto-stop when "${opts.stopOn}" operation is detected.\n`,
            );
          }
          process.stderr.write(
            `Timeout: ${duration}s. Press Ctrl+C to stop early.\n`,
          );

          const finishRecording = async () => {
            process.stderr.write("\nStopping recording...\n");
            const cookies = await recorder.extractCookies("doordash.com");
            const entries = await recorder.stop();

            const recording: SessionRecording = {
              id: crypto.randomUUID(),
              startedAt: startTime,
              endedAt: Date.now() / 1000,
              targetDomain: "doordash.com",
              networkEntries: entries,
              cookies,
              observations: [],
            };

            const recordingPath = saveRecording(recording);

            // Extract and save queries
            const queries = extractQueries(recording);
            let queriesPath: string | undefined;
            if (queries.length > 0) {
              queriesPath = saveQueries(queries);
            }

            process.stderr.write(`\nRecording saved: ${recordingPath}\n`);
            process.stderr.write(`Network entries: ${entries.length}\n`);
            process.stderr.write(
              `GraphQL operations captured: ${queries.length}\n`,
            );
            if (queries.length > 0) {
              process.stderr.write("Operations:\n");
              for (const q of queries) {
                const varsKeys =
                  q.exampleVariables && typeof q.exampleVariables === "object"
                    ? Object.keys(
                        q.exampleVariables as Record<string, unknown>,
                      ).join(", ")
                    : "(none)";
                process.stderr.write(
                  `  - ${q.operationName} [vars: ${varsKeys}]\n`,
                );
              }
              process.stderr.write(`Queries saved: ${queriesPath}\n`);
            }

            output(
              {
                ok: true,
                recordingId: recording.id,
                recordingPath,
                networkEntries: entries.length,
                queriesCaptured: queries.length,
                operations: queries.map((q) => q.operationName),
                queriesPath,
              },
              json,
            );
          };

          await new Promise<void>((resolve) => {
            let poll: ReturnType<typeof setInterval> | undefined;

            // Timeout
            const timer = setTimeout(() => {
              if (poll) clearInterval(poll);
              process.stderr.write(`\nTimeout reached (${duration}s).\n`);
              resolve();
            }, duration * 1000);

            // Ctrl+C
            process.on("SIGINT", () => {
              if (poll) clearInterval(poll);
              clearTimeout(timer);
              resolve();
            });

            // --stop-on: poll entries for the target operation
            if (opts.stopOn) {
              const target = opts.stopOn;
              poll = setInterval(() => {
                const entries = recorder.getEntries();
                const found = entries.some((e) => {
                  if (!e.request.postData) return false;
                  try {
                    const body = JSON.parse(e.request.postData) as {
                      operationName?: string;
                    };
                    return body.operationName === target;
                  } catch {
                    return false;
                  }
                });
                if (found) {
                  clearInterval(poll);
                  clearTimeout(timer);
                  process.stderr.write(`\nDetected "${target}" operation.\n`);
                  // Small delay to let the response come back
                  setTimeout(() => resolve(), 3000);
                }
              }, 500);
            }
          });

          await finishRecording();
        } catch (err) {
          outputError(err instanceof Error ? err.message : String(err));
        }
      },
    );

  // =========================================================================
  // inspect — inspect a recording's GraphQL operations
  // =========================================================================
  dd.command("inspect")
    .description("Inspect GraphQL operations in a recording")
    .argument("<recordingId>", "Recording ID or path to recording JSON file")
    .option("--op <operationName>", "Filter to a specific operation name")
    .option(
      "--extract-options",
      "Extract item customization options from updateCartItem operations",
    )
    .action(
      async (
        recordingIdOrPath: string,
        opts: { op?: string; extractOptions?: boolean },
        cmd: Command,
      ) => {
        const json = getJson(cmd);

        try {
          let recording: SessionRecording | null = null;

          // Try as path first, then as recording ID
          if (
            recordingIdOrPath.includes("/") ||
            recordingIdOrPath.endsWith(".json")
          ) {
            try {
              const { readFileSync } = await import("node:fs");
              recording = JSON.parse(
                readFileSync(recordingIdOrPath, "utf-8"),
              ) as SessionRecording;
            } catch {
              // Fall through to try as ID
            }
          }
          if (!recording) {
            recording = loadRecording(recordingIdOrPath);
          }

          if (!recording) {
            outputError(`Recording not found: ${recordingIdOrPath}`);
            return;
          }

          const queries = extractQueries(recording);

          if (opts.extractOptions) {
            const cartOps = queries.filter(
              (q) => q.operationName === "updateCartItem",
            );
            if (cartOps.length === 0) {
              outputError(
                "No updateCartItem operations found in this recording",
              );
              return;
            }

            const extracted = cartOps.map((q) => {
              const vars = (q.exampleVariables ?? {}) as Record<
                string,
                unknown
              >;
              const params = (vars.updateCartItemApiParams ?? {}) as Record<
                string,
                unknown
              >;
              return {
                itemId: params.itemId as string | undefined,
                itemName: params.itemName as string | undefined,
                nestedOptions: params.nestedOptions as string | undefined,
                specialInstructions: params.specialInstructions as
                  | string
                  | undefined,
                unitPrice: params.unitPrice as number | undefined,
                menuId: params.menuId as string | undefined,
                storeId: params.storeId as string | undefined,
              };
            });

            if (json) {
              output(
                { ok: true, items: extracted, count: extracted.length },
                true,
              );
            } else {
              for (const item of extracted) {
                process.stderr.write(
                  `\nItem: ${item.itemName ?? "unknown"} (${
                    item.itemId ?? "?"
                  })\n`,
                );
                process.stderr.write(
                  `  Store: ${item.storeId ?? "?"}, Menu: ${
                    item.menuId ?? "?"
                  }\n`,
                );
                process.stderr.write(
                  `  Unit Price: ${item.unitPrice ?? "?"}\n`,
                );
                if (item.specialInstructions) {
                  process.stderr.write(
                    `  Special Instructions: ${item.specialInstructions}\n`,
                  );
                }
                process.stderr.write(
                  `  Options: ${item.nestedOptions ?? "[]"}\n`,
                );
              }
            }
            return;
          }

          if (opts.op) {
            const match = queries.find((q) => q.operationName === opts.op);
            if (!match) {
              outputError(
                `Operation "${opts.op}" not found. Available: ${queries
                  .map((q) => q.operationName)
                  .join(", ")}`,
              );
              return;
            }

            if (json) {
              output({ ok: true, operation: match }, true);
            } else {
              process.stderr.write(`Operation: ${match.operationName}\n`);
              process.stderr.write(
                `Captured at: ${new Date(
                  match.capturedAt * 1000,
                ).toISOString()}\n\n`,
              );
              process.stderr.write("--- Query ---\n");
              process.stderr.write(match.query + "\n\n");
              process.stderr.write("--- Variables ---\n");
              process.stderr.write(
                JSON.stringify(match.exampleVariables, null, 2) + "\n",
              );
            }
          } else {
            if (json) {
              output(
                { ok: true, operations: queries, count: queries.length },
                true,
              );
            } else {
              process.stderr.write(`Recording: ${recording.id}\n`);
              process.stderr.write(
                `Total network entries: ${recording.networkEntries.length}\n`,
              );
              process.stderr.write(`GraphQL operations: ${queries.length}\n\n`);

              for (const q of queries) {
                const varsKeys =
                  q.exampleVariables && typeof q.exampleVariables === "object"
                    ? Object.keys(
                        q.exampleVariables as Record<string, unknown>,
                      ).join(", ")
                    : "(none)";
                process.stderr.write(`  ${q.operationName}\n`);
                process.stderr.write(`    Variables: ${varsKeys}\n`);
                process.stderr.write(
                  `    Captured: ${new Date(
                    q.capturedAt * 1000,
                  ).toISOString()}\n`,
                );
              }
            }
          }
        } catch (err) {
          outputError(err instanceof Error ? err.message : String(err));
        }
      },
    );

  // =========================================================================
  // status — check session status
  // =========================================================================
  dd.command("status")
    .description("Check if a DoorDash session is active")
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
  // search — search for restaurants/stores
  // =========================================================================
  dd.command("search")
    .description("Search for restaurants on DoorDash")
    .argument("<query>", 'Search query (e.g. "pizza", "thai food")')
    .action(async (query: string, _opts: unknown, cmd: Command) => {
      await run(cmd, async () => {
        const results = await search(query);
        return { results, count: results.length };
      });
    });

  // =========================================================================
  // store-search — search for items within a specific retail/convenience store
  // =========================================================================
  dd.command("store-search")
    .description(
      "Search for items within a specific store (best for convenience/pharmacy stores)",
    )
    .argument("<storeId>", "DoorDash store ID")
    .argument("<query>", 'Search query (e.g. "tylenol", "advil")')
    .option("--limit <n>", "Max results", "30")
    .action(
      async (
        storeId: string,
        query: string,
        opts: { limit: string },
        cmd: Command,
      ) => {
        await run(cmd, async () => {
          const result = await retailSearch(storeId, query, {
            limit: parseInt(opts.limit, 10),
          });
          return result;
        });
      },
    );

  // =========================================================================
  // search-items — search for items across all stores (works for convenience/retail)
  // =========================================================================
  dd.command("search-items")
    .description(
      "Search for items across all stores (works for convenience/retail stores)",
    )
    .argument("<query>", 'Search query (e.g. "tylenol", "advil")')
    .option("--debug", "Print raw response to stderr")
    .action(async (query: string, opts: { debug?: boolean }, cmd: Command) => {
      await run(cmd, async () => {
        const results = await searchItems(query, { debug: opts.debug });
        return { results, count: results.length };
      });
    });

  // =========================================================================
  // menu — get a store's menu
  // =========================================================================
  dd.command("menu")
    .description("Get a restaurant's menu by store ID")
    .argument("<storeId>", "DoorDash store ID")
    .option("--menu-id <menuId>", "Specific menu ID (optional)")
    .option("--debug", "Print raw response structure to stderr")
    .action(
      async (
        storeId: string,
        opts: { menuId?: string; debug?: boolean },
        cmd: Command,
      ) => {
        await run(cmd, async () => {
          const store = await getStoreMenu(storeId, opts.menuId, {
            debug: opts.debug,
          });
          return { store };
        });
      },
    );

  // =========================================================================
  // item — get item details
  // =========================================================================
  dd.command("item")
    .description("Get details for a specific menu item")
    .argument("<storeId>", "DoorDash store ID")
    .argument("<itemId>", "Menu item ID")
    .action(
      async (storeId: string, itemId: string, _opts: unknown, cmd: Command) => {
        await run(cmd, async () => {
          const item = await getItemDetails(storeId, itemId);
          return { item };
        });
      },
    );

  // =========================================================================
  // cart — cart operations (subcommand group)
  // =========================================================================
  const cart = dd.command("cart").description("Cart operations");

  // cart add
  cart
    .command("add")
    .description("Add an item to your cart")
    .requiredOption("--store-id <storeId>", "Store ID")
    .requiredOption("--menu-id <menuId>", "Menu ID")
    .requiredOption("--item-id <itemId>", "Item ID")
    .requiredOption("--item-name <name>", "Item name")
    .requiredOption("--unit-price <cents>", "Unit price in cents")
    .option("--quantity <n>", "Quantity", "1")
    .option("--cart-id <cartId>", "Existing cart ID (creates new if omitted)")
    .option("--special-instructions <text>", "Special instructions")
    .option(
      "--options <json>",
      "Item customization options as JSON array (from item details or recording)",
    )
    .action(
      async (
        opts: {
          storeId: string;
          menuId: string;
          itemId: string;
          itemName: string;
          unitPrice: string;
          quantity: string;
          cartId?: string;
          specialInstructions?: string;
          options?: string;
        },
        cmd: Command,
      ) => {
        await run(cmd, async () => {
          const result = await addToCart({
            storeId: opts.storeId,
            menuId: opts.menuId,
            itemId: opts.itemId,
            itemName: opts.itemName,
            unitPrice: parseInt(opts.unitPrice, 10),
            quantity: parseInt(opts.quantity, 10),
            cartId: opts.cartId,
            specialInstructions: opts.specialInstructions,
            nestedOptions: opts.options,
          });
          return { cart: result };
        });
      },
    );

  // cart remove
  cart
    .command("remove")
    .description("Remove an item from your cart")
    .requiredOption("--cart-id <cartId>", "Cart ID")
    .requiredOption("--item-id <itemId>", "Order item ID (from cart view)")
    .action(async (opts: { cartId: string; itemId: string }, cmd: Command) => {
      await run(cmd, async () => {
        const result = await removeFromCart(opts.cartId, opts.itemId);
        return { cart: result };
      });
    });

  // cart view
  cart
    .command("view")
    .description("View cart contents")
    .argument("<cartId>", "Cart ID")
    .action(async (cartId: string, _opts: unknown, cmd: Command) => {
      await run(cmd, async () => {
        const result = await viewCart(cartId);
        return { cart: result };
      });
    });

  // cart list
  cart
    .command("list")
    .description("List all active carts")
    .option("--store-id <storeId>", "Filter by store ID")
    .action(async (opts: { storeId?: string }, cmd: Command) => {
      await run(cmd, async () => {
        const carts = await listCarts(opts.storeId);
        return { carts, count: carts.length };
      });
    });

  // cart learn — capture customization options via CDP recording
  cart
    .command("learn")
    .description(
      "Learn item customization options by recording a browser interaction. " +
        "Opens Chrome and watches you customize an item — when you add it to cart, " +
        "the nestedOptions and specialInstructions are extracted and output.",
    )
    .option("--duration <seconds>", "Max recording duration in seconds", "120")
    .action(async (opts: { duration: string }, cmd: Command) => {
      const json = getJson(cmd);
      const duration = parseInt(opts.duration, 10);

      try {
        const cdp = await ensureChromeWithCdp({
          startUrl: "https://www.doordash.com",
        });

        const startTime = Date.now() / 1000;
        const recorder = new NetworkRecorder("doordash.com");
        await recorder.startDirect(cdp.baseUrl);

        process.stderr.write(
          "Recording... Navigate to an item, customize it, and add it to cart.\n",
        );
        process.stderr.write(
          `Will auto-stop when "updateCartItem" is detected. Timeout: ${duration}s.\n`,
        );

        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (poll) clearInterval(poll);
            process.stderr.write(`\nTimeout reached (${duration}s).\n`);
            resolve();
          }, duration * 1000);

          process.on("SIGINT", () => {
            if (poll) clearInterval(poll);
            clearTimeout(timer);
            resolve();
          });

          const poll = setInterval(() => {
            const entries = recorder.getEntries();
            const found = entries.some((e) => {
              if (!e.request.postData) return false;
              try {
                const body = JSON.parse(e.request.postData) as {
                  operationName?: string;
                };
                return body.operationName === "updateCartItem";
              } catch {
                return false;
              }
            });
            if (found) {
              clearInterval(poll);
              clearTimeout(timer);
              process.stderr.write('\nDetected "updateCartItem" operation.\n');
              setTimeout(() => resolve(), 3000);
            }
          }, 500);
        });

        process.stderr.write("Stopping recording...\n");
        const cookies = await recorder.extractCookies("doordash.com");
        const entries = await recorder.stop();

        const recording: SessionRecording = {
          id: crypto.randomUUID(),
          startedAt: startTime,
          endedAt: Date.now() / 1000,
          targetDomain: "doordash.com",
          networkEntries: entries,
          cookies,
          observations: [],
        };

        // Extract updateCartItem operations
        const queries = extractQueries(recording);
        const cartOps = queries.filter(
          (q) => q.operationName === "updateCartItem",
        );

        if (cartOps.length === 0) {
          outputError(
            "No updateCartItem operations captured. Did you add an item to cart?",
          );
          return;
        }

        const extracted = cartOps.map((q) => {
          const vars = (q.exampleVariables ?? {}) as Record<string, unknown>;
          const params = (vars.updateCartItemApiParams ?? {}) as Record<
            string,
            unknown
          >;
          return {
            itemId: params.itemId as string | undefined,
            itemName: params.itemName as string | undefined,
            nestedOptions: params.nestedOptions as string | undefined,
            specialInstructions: params.specialInstructions as
              | string
              | undefined,
            unitPrice: params.unitPrice as number | undefined,
            menuId: params.menuId as string | undefined,
            storeId: params.storeId as string | undefined,
          };
        });

        // Also save the recording for future reference
        const recordingPath = saveRecording(recording);

        output(
          {
            ok: true,
            items: extracted,
            count: extracted.length,
            recordingId: recording.id,
            recordingPath,
          },
          json,
        );
      } catch (err) {
        outputError(err instanceof Error ? err.message : String(err));
      }
    });

  // =========================================================================
  // checkout — get checkout / dropoff options
  // =========================================================================
  dd.command("checkout")
    .description("Get delivery/dropoff options for a cart")
    .argument("<cartId>", "Cart ID")
    .option("--address-id <addressId>", "Delivery address ID")
    .action(
      async (cartId: string, opts: { addressId?: string }, cmd: Command) => {
        await run(cmd, async () => {
          const options = await getDropoffOptions(cartId, opts.addressId);
          return { dropoffOptions: options };
        });
      },
    );

  // =========================================================================
  // order — order operations (subcommand group)
  // =========================================================================
  const order = dd.command("order").description("Order operations");

  // order place
  order
    .command("place")
    .description("Place an order from a cart")
    .requiredOption("--cart-id <cartId>", "Cart ID")
    .requiredOption("--store-id <storeId>", "Store ID")
    .requiredOption("--total <cents>", "Order total in cents")
    .option("--tip <cents>", "Tip amount in cents", "0")
    .option("--delivery-option <type>", "Delivery option type", "STANDARD")
    .option(
      "--dropoff-option <id>",
      "Dropoff option ID (from checkout command)",
    )
    .option(
      "--payment-uuid <uuid>",
      "Payment method UUID (uses default if omitted)",
    )
    .option("--payment-type <type>", "Payment method type", "Card")
    .action(
      async (
        opts: {
          cartId: string;
          storeId: string;
          total: string;
          tip: string;
          deliveryOption: string;
          dropoffOption?: string;
          paymentUuid?: string;
          paymentType: string;
        },
        cmd: Command,
      ) => {
        await run(cmd, async () => {
          const result = await placeOrder({
            cartId: opts.cartId,
            storeId: opts.storeId,
            total: parseInt(opts.total, 10),
            tipAmount: parseInt(opts.tip, 10),
            deliveryOptionType: opts.deliveryOption,
            dropoffOptionId: opts.dropoffOption,
            paymentMethodUuid: opts.paymentUuid,
            paymentMethodType: opts.paymentType,
          });
          return { order: result };
        });
      },
    );

  // =========================================================================
  // payment-methods — list saved payment methods
  // =========================================================================
  dd.command("payment-methods")
    .description("List saved payment methods")
    .action(async (_opts: unknown, cmd: Command) => {
      await run(cmd, async () => {
        const methods = await getPaymentMethods();
        return { methods, count: methods.length };
      });
    });
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
  // Step 1: Ensure Chrome is running with CDP
  await ensureChromeWithCdp({
    startUrl: "https://www.doordash.com/consumer/login/",
  });

  // Step 2: Start ride-shotgun learn session via HTTP
  const port = getHttpPort();
  const baseUrl = buildDaemonUrl(port);
  const token = readHttpToken();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const startResponse = await fetch(
    `${baseUrl}/v1/computer-use/ride-shotgun/start`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        durationSeconds,
        intervalSeconds: 5,
        mode: "learn",
        targetDomain: "doordash.com",
      }),
    },
  );

  if (!startResponse.ok) {
    const errorBody = await startResponse.text();
    throw new Error(
      `Failed to start ride-shotgun session (HTTP ${startResponse.status}): ${errorBody}`,
    );
  }

  const startResult = (await startResponse.json()) as {
    watchId: string;
    sessionId: string;
  };

  if (!startResult.watchId) {
    throw new Error("Ride-shotgun start response missing watchId");
  }

  // Step 3: Poll session status endpoint for completion or failure, then
  // look for the correlated recording file using the recordingId from the session.
  const { watchId } = startResult;
  const statusUrl = `${baseUrl}/v1/computer-use/ride-shotgun/status/${watchId}`;
  const timeoutMs = (durationSeconds + 30) * 1000;
  const pollIntervalMs = 2000;
  const startTime = Date.now();

  return new Promise<LearnResult>((resolve, reject) => {
    const pollOnce = async () => {
      if (Date.now() - startTime > timeoutMs) {
        reject(
          new Error(`Learn session timed out after ${durationSeconds + 30}s`),
        );
        return;
      }

      // Poll session status to detect failures early
      try {
        const statusRes = await fetch(statusUrl, { headers });
        if (statusRes.ok) {
          const status = (await statusRes.json()) as {
            status: string;
            recordingId?: string;
            savedRecordingPath?: string;
            bootstrapFailureReason?: string;
          };

          // Session failed without producing a recording
          if (status.bootstrapFailureReason) {
            reject(
              new Error(
                `Learn session failed: ${status.bootstrapFailureReason}`,
              ),
            );
            return;
          }

          // Session completed — check for the correlated recording file
          if (status.status === "completed") {
            if (status.savedRecordingPath && status.recordingId) {
              resolve({
                recordingId: status.recordingId,
                recordingPath: status.savedRecordingPath,
              });
              return;
            }

            // Recording path not in status — fall back to filesystem lookup
            // using the recordingId for correlation
            if (status.recordingId) {
              const recordingsDir = join(getDataDir(), "recordings");
              const expectedPath = join(
                recordingsDir,
                `${status.recordingId}.json`,
              );
              try {
                statSync(expectedPath);
                resolve({
                  recordingId: status.recordingId,
                  recordingPath: expectedPath,
                });
                return;
              } catch {
                // Recording file not yet written — continue polling
                setTimeout(pollOnce, pollIntervalMs);
                return;
              }
            }

            // Completed but no recordingId — cannot correlate
            reject(
              new Error(
                "Learn session completed but no recording was saved.",
              ),
            );
            return;
          }
        }
      } catch {
        // Status endpoint not reachable — continue polling
      }

      setTimeout(pollOnce, pollIntervalMs);
    };

    setTimeout(pollOnce, pollIntervalMs);
  });
}
