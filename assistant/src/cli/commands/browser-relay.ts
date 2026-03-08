import type { Command } from "commander";

import {
  initAuthSigningKey,
  isSigningKeyInitialized,
  loadOrCreateSigningKey,
} from "../../runtime/auth/token-service.js";
import {
  gatewayGet,
  gatewayPost,
} from "../../runtime/gateway-internal-client.js";
import {
  ensureChromeWithCdp,
  minimizeChromeWindow,
  restoreChromeWindow,
} from "../../tools/browser/chrome-cdp.js";

// ---------------------------------------------------------------------------
// Shared relay helper
// ---------------------------------------------------------------------------

async function relayCommand(command: Record<string, unknown>): Promise<void> {
  try {
    if (!isSigningKeyInitialized()) {
      initAuthSigningKey(loadOrCreateSigningKey());
    }

    const { data } = await gatewayPost<{
      id: string;
      success: boolean;
      result?: unknown;
      error?: string;
      tabId?: number;
    }>("/v1/browser-relay/command", command);

    if (data.success) {
      process.stdout.write(
        JSON.stringify({
          ok: true,
          ...(data.tabId !== undefined ? { tabId: data.tabId } : {}),
          ...(data.result !== undefined ? { result: data.result } : {}),
        }) + "\n",
      );
    } else {
      process.stdout.write(
        JSON.stringify({
          ok: false,
          error: data.error ?? "Unknown relay error",
        }) + "\n",
      );
      process.exitCode = 1;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(JSON.stringify({ ok: false, error: message }) + "\n");
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Stdin reader helper
// ---------------------------------------------------------------------------

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerBrowserRelayCommand(program: Command): void {
  const browser = program
    .command("browser")
    .description(
      "Browser automation, extension relay, and Chrome CDP management",
    );

  browser.addHelpText(
    "after",
    `
Browser automation commands. Use a browser-specific subcommand to interact
with browser tabs and extensions.

Examples:
  $ assistant browser chrome relay find-tab --url "*://*.instagram.com/*"
  $ assistant browser chrome relay evaluate --tab-id 123 --code "document.title"
  $ assistant browser chrome relay screenshot --tab-id 123
  $ assistant browser chrome relay status`,
  );

  const chrome = browser
    .command("chrome")
    .description("Chrome browser automation via the extension relay");

  chrome.addHelpText(
    "after",
    `
Manages a dedicated Chrome instance with Chrome DevTools Protocol (CDP)
enabled, separate from the user's regular Chrome profile. The CDP instance
uses a dedicated user data directory at ~/Library/Application Support/Google/Chrome-CDP
and defaults to port 9222. Commands are routed through a Chrome extension
relay that bridges the assistant to open Chrome tabs.

Subgroups:
  relay     Send commands to Chrome tabs via the browser extension relay
  launch    Launch or connect to a Chrome CDP instance
  minimize  Minimize the Chrome CDP window
  restore   Restore the Chrome CDP window

Examples:
  $ assistant browser chrome launch
  $ assistant browser chrome launch --start-url "https://example.com" --port 9333
  $ assistant browser chrome minimize
  $ assistant browser chrome restore
  $ assistant browser chrome relay status
  $ assistant browser chrome relay find-tab --url "*://*.github.com/*"`,
  );

  const relay = chrome
    .command("relay")
    .description(
      "Send commands to Chrome tabs via the browser extension relay",
    );

  relay.addHelpText(
    "after",
    `
Routes commands to Chrome tabs through the browser extension relay. The relay
connects the assistant to a Chrome extension that can inspect and control
browser tabs.

Available subcommands:
  find-tab      Find a tab matching a URL pattern
  new-tab       Open a new tab with a URL
  navigate      Navigate an existing tab to a new URL
  evaluate      Execute JavaScript in a tab
  get-cookies   Fetch cookies for a domain
  set-cookie    Set a cookie
  screenshot    Capture a screenshot of a tab
  status        Check browser extension relay connection status

Examples:
  $ assistant browser chrome relay find-tab --url "*://*.amazon.com/*"
  $ assistant browser chrome relay new-tab --url "https://example.com"
  $ assistant browser chrome relay evaluate --tab-id 42 --code "document.title"
  $ echo "document.querySelectorAll('a').length" | assistant browser chrome relay evaluate --tab-id 42`,
  );

  // -- find-tab --

  relay
    .command("find-tab")
    .description("Find a tab matching a URL glob pattern")
    .requiredOption(
      "--url <pattern>",
      "URL glob pattern to match (e.g. *://*.instagram.com/*)",
    )
    .addHelpText(
      "after",
      `
Arguments:
  --url <pattern>   Glob pattern matched against open tab URLs. Supports
                    wildcards: *://*.instagram.com/* matches any Instagram page.

Returns the tab ID of the first matching tab, or an error if no match is found.

Examples:
  $ assistant browser chrome relay find-tab --url "*://*.amazon.com/*"
  $ assistant browser chrome relay find-tab --url "*://mail.google.com/*"`,
    )
    .action(async (opts: { url: string }) => {
      await relayCommand({ action: "find_tab", url: opts.url });
    });

  // -- new-tab --

  relay
    .command("new-tab")
    .description("Open a new tab with the given URL")
    .requiredOption("--url <url>", "URL to open in a new tab")
    .addHelpText(
      "after",
      `
Arguments:
  --url <url>   The full URL to open in a new Chrome tab.

Returns the tab ID of the newly created tab.

Examples:
  $ assistant browser chrome relay new-tab --url "https://example.com"
  $ assistant browser chrome relay new-tab --url "https://www.instagram.com/explore/"`,
    )
    .action(async (opts: { url: string }) => {
      await relayCommand({ action: "new_tab", url: opts.url });
    });

  // -- navigate --

  relay
    .command("navigate")
    .description("Navigate an existing tab to a new URL")
    .requiredOption("--tab-id <id>", "Target tab ID", parseInt)
    .requiredOption("--url <url>", "URL to navigate to")
    .addHelpText(
      "after",
      `
Arguments:
  --tab-id <id>   Numeric Chrome tab ID (from find-tab or new-tab output).
  --url <url>     The URL to navigate the tab to.

Examples:
  $ assistant browser chrome relay navigate --tab-id 123 --url "https://example.com/page2"`,
    )
    .action(async (opts: { tabId: number; url: string }) => {
      await relayCommand({
        action: "navigate",
        tabId: opts.tabId,
        url: opts.url,
      });
    });

  // -- evaluate --

  relay
    .command("evaluate")
    .description("Execute JavaScript in a Chrome tab")
    .requiredOption("--tab-id <id>", "Target tab ID", parseInt)
    .option("--code <script>", "JavaScript code to evaluate in the tab")
    .addHelpText(
      "after",
      `
Arguments:
  --tab-id <id>      Numeric Chrome tab ID (from find-tab or new-tab output).
  --code <script>    JavaScript code to evaluate. If omitted, reads from stdin.

If --code is omitted, reads JavaScript from stdin. This is useful for long
scripts that would be unwieldy as a single CLI argument.

Examples:
  $ assistant browser chrome relay evaluate --tab-id 123 --code "document.title"
  $ echo "document.querySelectorAll('a').length" | assistant browser chrome relay evaluate --tab-id 123
  $ cat scrape.js | assistant browser chrome relay evaluate --tab-id 123`,
    )
    .action(async (opts: { tabId: number; code?: string }) => {
      let code: string;
      if (opts.code) {
        code = opts.code;
      } else if (process.stdin.isTTY) {
        process.stdout.write(
          JSON.stringify({
            ok: false,
            error: "No code provided. Use --code or pipe JavaScript via stdin.",
          }) + "\n",
        );
        process.exitCode = 1;
        return;
      } else {
        code = await readStdin();
      }

      await relayCommand({
        action: "evaluate",
        tabId: opts.tabId,
        code,
      });
    });

  // -- get-cookies --

  relay
    .command("get-cookies")
    .description("Fetch cookies for a domain")
    .requiredOption("--domain <domain>", "Cookie domain to fetch")
    .addHelpText(
      "after",
      `
Arguments:
  --domain <domain>   The cookie domain to query (e.g. ".instagram.com").

Returns all cookies matching the specified domain.

Examples:
  $ assistant browser chrome relay get-cookies --domain ".instagram.com"
  $ assistant browser chrome relay get-cookies --domain ".amazon.com"`,
    )
    .action(async (opts: { domain: string }) => {
      await relayCommand({ action: "get_cookies", domain: opts.domain });
    });

  // -- set-cookie --

  relay
    .command("set-cookie")
    .description("Set a cookie in the browser")
    .requiredOption("--cookie <json>", "Cookie specification as JSON")
    .addHelpText(
      "after",
      `
Arguments:
  --cookie <json>   JSON object specifying the cookie to set. Must include
                    at minimum "name", "value", and "domain" fields.

Examples:
  $ assistant browser chrome relay set-cookie --cookie '{"name":"session","value":"abc123","domain":".example.com"}'`,
    )
    .action(async (opts: { cookie: string }) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(opts.cookie);
      } catch {
        process.stdout.write(
          JSON.stringify({
            ok: false,
            error: "Invalid JSON in --cookie argument",
          }) + "\n",
        );
        process.exitCode = 1;
        return;
      }
      await relayCommand({ action: "set_cookie", cookie: parsed });
    });

  // -- screenshot --

  relay
    .command("screenshot")
    .description("Capture a screenshot of a Chrome tab")
    .option("--tab-id <id>", "Target tab ID", parseInt)
    .addHelpText(
      "after",
      `
Arguments:
  --tab-id <id>   Optional numeric Chrome tab ID. If omitted, captures
                  the currently active tab.

Returns a base64-encoded screenshot image.

Examples:
  $ assistant browser chrome relay screenshot --tab-id 123
  $ assistant browser chrome relay screenshot`,
    )
    .action(async (opts: { tabId?: number }) => {
      await relayCommand({
        action: "screenshot",
        ...(opts.tabId !== undefined ? { tabId: opts.tabId } : {}),
      });
    });

  // -- status --

  relay
    .command("status")
    .description("Check browser extension relay connection status")
    .addHelpText(
      "after",
      `
Reports whether the browser extension relay is connected, including the
connection ID, last heartbeat time, and number of pending commands.

Examples:
  $ assistant browser chrome relay status`,
    )
    .action(async () => {
      try {
        if (!isSigningKeyInitialized()) {
          initAuthSigningKey(loadOrCreateSigningKey());
        }
        const data = await gatewayGet<{
          connected: boolean;
          connectionId?: string;
          lastHeartbeatAt?: number;
          pendingCommandCount: number;
        }>("/v1/browser-relay/status");
        process.stdout.write(
          JSON.stringify({
            ok: true,
            connected: data.connected,
            connectionId: data.connectionId ?? null,
            lastHeartbeatAt: data.lastHeartbeatAt
              ? new Date(data.lastHeartbeatAt).toISOString()
              : null,
            pendingCommandCount: data.pendingCommandCount,
          }) + "\n",
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stdout.write(
          JSON.stringify({ ok: false, error: message }) + "\n",
        );
        process.exitCode = 1;
      }
    });

  // ---------------------------------------------------------------------------
  // chrome launch
  // ---------------------------------------------------------------------------

  chrome
    .command("launch")
    .description(
      "Launch or connect to a Chrome instance with CDP (Chrome DevTools Protocol)",
    )
    .option("--start-url <url>", "Initial URL to open when launching Chrome")
    .option("--port <port>", "CDP port (default: 9222)", parseInt)
    .addHelpText(
      "after",
      `
Launches a Chrome instance with Chrome DevTools Protocol (CDP) enabled, or
returns the existing session if Chrome is already running with open tabs.
Idempotent — returns immediately if Chrome is already running with tabs.
Kills stale CDP instances (CDP endpoint up but no tabs) and relaunches.
Polls up to 15 seconds for the CDP endpoint to become ready.

Arguments:
  --start-url <url>   Initial URL to open in the new Chrome window. If
                      omitted, Chrome opens to its default start page.
  --port <port>       CDP port to use. Defaults to 9222.

Examples:
  $ assistant browser chrome launch
  $ assistant browser chrome launch --start-url "https://x.com/login" --port 9333`,
    )
    .action(async (opts: { startUrl?: string; port?: number }) => {
      try {
        const session = await ensureChromeWithCdp({
          startUrl: opts.startUrl,
          port: opts.port,
        });
        process.stdout.write(
          JSON.stringify({
            ok: true,
            baseUrl: session.baseUrl,
            launchedByUs: session.launchedByUs,
            userDataDir: session.userDataDir,
          }) + "\n",
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stdout.write(
          JSON.stringify({ ok: false, error: message }) + "\n",
        );
        process.exitCode = 1;
      }
    });

  // ---------------------------------------------------------------------------
  // chrome minimize
  // ---------------------------------------------------------------------------

  chrome
    .command("minimize")
    .description("Minimize the Chrome CDP window")
    .option("--port <port>", "CDP port (default: 9222)", parseInt)
    .addHelpText(
      "after",
      `
Minimizes the Chrome window associated with the CDP session. Uses the
Browser.setWindowBounds CDP method to set the window state to minimized.

Arguments:
  --port <port>   CDP port to connect to. Defaults to 9222.

Examples:
  $ assistant browser chrome minimize
  $ assistant browser chrome minimize --port 9333`,
    )
    .action(async (opts: { port?: number }) => {
      try {
        const cdpBase = opts.port ? `http://localhost:${opts.port}` : undefined;
        await minimizeChromeWindow(cdpBase);
        process.stdout.write(JSON.stringify({ ok: true }) + "\n");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stdout.write(
          JSON.stringify({ ok: false, error: message }) + "\n",
        );
        process.exitCode = 1;
      }
    });

  // ---------------------------------------------------------------------------
  // chrome restore
  // ---------------------------------------------------------------------------

  chrome
    .command("restore")
    .description("Restore the Chrome CDP window from minimized state")
    .option("--port <port>", "CDP port (default: 9222)", parseInt)
    .addHelpText(
      "after",
      `
Restores (un-minimizes) the Chrome window associated with the CDP session.
Uses the Browser.setWindowBounds CDP method to set the window state to normal.

Arguments:
  --port <port>   CDP port to connect to. Defaults to 9222.

Examples:
  $ assistant browser chrome restore
  $ assistant browser chrome restore --port 9333`,
    )
    .action(async (opts: { port?: number }) => {
      try {
        const cdpBase = opts.port ? `http://localhost:${opts.port}` : undefined;
        await restoreChromeWindow(cdpBase);
        process.stdout.write(JSON.stringify({ ok: true }) + "\n");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stdout.write(
          JSON.stringify({ ok: false, error: message }) + "\n",
        );
        process.exitCode = 1;
      }
    });
}
