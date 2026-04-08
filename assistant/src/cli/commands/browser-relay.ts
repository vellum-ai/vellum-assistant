/**
 * `assistant browser chrome relay <action>` CLI shim.
 *
 * Translates the legacy relay actions (find_tab, new_tab, navigate,
 * evaluate, get_cookies, set_cookie, screenshot) into Chrome DevTools
 * Protocol commands and forwards them to the daemon's
 * `/v1/browser-cdp` HTTP endpoint, which routes the command through
 * the connected chrome-extension WebSocket.
 *
 * Why this exists: PR #24329 deleted the in-process extension relay
 * server and the original CLI surface. Two in-tree skills (amazon and
 * influencer) still spawn `assistant browser chrome relay <action>` as
 * a subprocess and parse the JSON output. Until those skills migrate
 * onto the new CDP-based skill API, this shim keeps them working by
 * preserving the legacy stdout contract:
 *
 *     { "ok": true,  "tabId"?: <id>, "result"?: <unknown> }
 *     { "ok": false, "error": <string> }
 *
 * The CLI mints a short-lived daemon delivery JWT (same audience and
 * scope profile as the daemon's internal callbacks) and POSTs directly
 * to the runtime's loopback HTTP port — no gateway involvement
 * required.
 */

import { existsSync, readFileSync } from "node:fs";

import type { Command } from "commander";

import { getRuntimeHttpPort } from "../../config/env.js";
import { CURRENT_POLICY_EPOCH } from "../../runtime/auth/policy.js";
import { mintToken } from "../../runtime/auth/token-service.js";
import {
  initAuthSigningKey,
  isSigningKeyInitialized,
  loadOrCreateSigningKey,
} from "../../runtime/auth/token-service.js";
import { getRuntimePortFilePath } from "../../util/platform.js";

// ---------------------------------------------------------------------------
// Daemon HTTP client
// ---------------------------------------------------------------------------

interface BrowserCdpResponse {
  result?: unknown;
  error?: { code: string; message: string };
}

/**
 * Resolve the daemon's runtime HTTP port. Prefers the runtime-port
 * file written by the daemon at startup so non-default ports
 * (RUNTIME_HTTP_PORT) are picked up automatically without an env var
 * roundtrip. Falls back to the env-var-derived default.
 */
function resolveRuntimePort(): number {
  try {
    const portFile = getRuntimePortFilePath();
    if (existsSync(portFile)) {
      const raw = readFileSync(portFile, "utf-8").trim();
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed > 0 && parsed < 65536) {
        return parsed;
      }
    }
  } catch {
    // Fall through to env-var default
  }
  return getRuntimeHttpPort();
}

/**
 * Mint a short-lived JWT acceptable to the runtime auth middleware.
 * Mirrors `mintDaemonDeliveryToken` (sub=svc:daemon:self,
 * scope_profile=gateway_service_v1, aud=vellum-daemon) but is minted
 * out-of-process by the CLI using the on-disk signing key.
 */
function mintCliToken(): string {
  if (!isSigningKeyInitialized()) {
    initAuthSigningKey(loadOrCreateSigningKey());
  }
  return mintToken({
    aud: "vellum-daemon",
    sub: "svc:daemon:self",
    scope_profile: "gateway_service_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: 60,
  });
}

/**
 * Send a single CDP command to the daemon's /v1/browser-cdp route and
 * return the parsed response. Throws on transport-level errors; the
 * caller wraps the throw into a `{ ok: false, error }` envelope.
 */
async function postBrowserCdp(payload: {
  cdpMethod: string;
  cdpParams?: Record<string, unknown>;
  cdpSessionId?: string;
  timeoutMs?: number;
}): Promise<BrowserCdpResponse> {
  const port = resolveRuntimePort();
  const token = mintCliToken();
  const url = `http://127.0.0.1:${port}/v1/browser-cdp`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  const bodyText = await resp.text();
  let parsed: BrowserCdpResponse;
  try {
    parsed = JSON.parse(bodyText) as BrowserCdpResponse;
  } catch {
    throw new Error(
      `Daemon returned non-JSON response (HTTP ${resp.status}): ${bodyText.slice(0, 200)}`,
    );
  }

  if (!resp.ok) {
    const message = parsed.error?.message ?? `HTTP ${resp.status}`;
    throw new Error(message);
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Stdout helpers
// ---------------------------------------------------------------------------

interface RelayResultOk {
  ok: true;
  tabId?: number | string;
  result?: unknown;
}

interface RelayResultErr {
  ok: false;
  error: string;
}

function emitOk(payload: Omit<RelayResultOk, "ok">): void {
  const out: RelayResultOk = { ok: true, ...payload };
  process.stdout.write(JSON.stringify(out) + "\n");
}

function emitError(message: string): void {
  const out: RelayResultErr = { ok: false, error: message };
  process.stdout.write(JSON.stringify(out) + "\n");
  process.exitCode = 1;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

// ---------------------------------------------------------------------------
// URL glob matching for find-tab
// ---------------------------------------------------------------------------

/**
 * Convert a Chrome match-pattern style glob (e.g. `*://*.amazon.com/*`)
 * into a regular expression. Matches the chrome.tabs.query semantics
 * the legacy relay CLI exposed:
 *
 *   - `*` is a wildcard that matches any sequence (including `/` in
 *     the path component, mirroring the legacy minimatch behaviour).
 *   - All other regex metacharacters are escaped.
 */
function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const pattern = "^" + escaped.replace(/\*/g, ".*") + "$";
  return new RegExp(pattern);
}

// ---------------------------------------------------------------------------
// Action handlers — translate legacy actions into CDP commands
// ---------------------------------------------------------------------------

interface CdpTarget {
  targetId: string;
  type: string;
  url: string;
  title?: string;
  attached?: boolean;
}

interface CdpTargetsResult {
  targetInfos: CdpTarget[];
}

async function actionFindTab(urlPattern: string): Promise<void> {
  try {
    const resp = await postBrowserCdp({ cdpMethod: "Target.getTargets" });
    const targets =
      (resp.result as CdpTargetsResult | undefined)?.targetInfos ?? [];
    const re = globToRegex(urlPattern);
    const match = targets.find((t) => t.type === "page" && re.test(t.url));
    if (!match) {
      emitError(`No tab matched URL pattern: ${urlPattern}`);
      return;
    }
    emitOk({ tabId: match.targetId });
  } catch (err) {
    emitError(err instanceof Error ? err.message : String(err));
  }
}

async function actionNewTab(url: string): Promise<void> {
  try {
    const resp = await postBrowserCdp({
      cdpMethod: "Target.createTarget",
      cdpParams: { url },
    });
    const targetId = (resp.result as { targetId?: string } | undefined)
      ?.targetId;
    if (!targetId) {
      emitError("Target.createTarget did not return a targetId");
      return;
    }
    emitOk({ tabId: targetId });
  } catch (err) {
    emitError(err instanceof Error ? err.message : String(err));
  }
}

async function actionNavigate(tabId: string, url: string): Promise<void> {
  try {
    await postBrowserCdp({
      cdpMethod: "Page.navigate",
      cdpParams: { url },
      cdpSessionId: tabId,
    });
    emitOk({});
  } catch (err) {
    emitError(err instanceof Error ? err.message : String(err));
  }
}

async function actionEvaluate(tabId: string, code: string): Promise<void> {
  try {
    const resp = await postBrowserCdp({
      cdpMethod: "Runtime.evaluate",
      cdpParams: {
        expression: code,
        returnByValue: true,
        awaitPromise: true,
      },
      cdpSessionId: tabId,
    });
    // CDP Runtime.evaluate returns { result: { type, value }, exceptionDetails? }.
    // Surface exceptions as relay errors so callers don't silently get undefined.
    const result = resp.result as
      | {
          result?: { value?: unknown };
          exceptionDetails?: {
            text?: string;
            exception?: { description?: string };
          };
        }
      | undefined;
    if (result?.exceptionDetails) {
      const desc =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "Runtime exception during evaluate";
      emitError(desc);
      return;
    }
    emitOk({ result: result?.result?.value });
  } catch (err) {
    emitError(err instanceof Error ? err.message : String(err));
  }
}

async function actionGetCookies(domain: string): Promise<void> {
  try {
    const resp = await postBrowserCdp({ cdpMethod: "Network.getCookies" });
    const cookies =
      (resp.result as { cookies?: Array<Record<string, unknown>> } | undefined)
        ?.cookies ?? [];
    // Filter by domain (Chrome stores cookies with leading-dot or bare-host
    // domains depending on the Set-Cookie source). Match either form so the
    // legacy "amazon.com" / ".amazon.com" callers both succeed.
    const trimmed = domain.startsWith(".") ? domain.slice(1) : domain;
    const filtered = cookies.filter((c) => {
      const d = String(c.domain ?? "");
      const dTrim = d.startsWith(".") ? d.slice(1) : d;
      return dTrim === trimmed || dTrim.endsWith("." + trimmed);
    });
    emitOk({ result: filtered });
  } catch (err) {
    emitError(err instanceof Error ? err.message : String(err));
  }
}

async function actionSetCookie(cookie: Record<string, unknown>): Promise<void> {
  try {
    await postBrowserCdp({
      cdpMethod: "Network.setCookie",
      cdpParams: cookie,
    });
    emitOk({});
  } catch (err) {
    emitError(err instanceof Error ? err.message : String(err));
  }
}

async function actionScreenshot(tabId?: string): Promise<void> {
  try {
    const resp = await postBrowserCdp({
      cdpMethod: "Page.captureScreenshot",
      cdpParams: { format: "png" },
      ...(tabId !== undefined ? { cdpSessionId: tabId } : {}),
    });
    const data = (resp.result as { data?: string } | undefined)?.data;
    if (data === undefined) {
      emitError("Page.captureScreenshot returned no data");
      return;
    }
    emitOk({ result: data });
  } catch (err) {
    emitError(err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerBrowserRelayCommand(program: Command): void {
  const browser = program
    .command("browser")
    .description(
      "Browser automation surface (`chrome relay <action>` CDP shim)",
    );

  browser.addHelpText(
    "after",
    `
Provides a thin CDP-over-HTTP shim used by in-tree skills that have not
yet migrated onto the new CDP-based skill API. Each command translates
the legacy action into a Chrome DevTools Protocol call and forwards it
to the daemon's /v1/browser-cdp route, which routes through the
connected chrome-extension WebSocket.

Examples:
  $ assistant browser chrome relay find-tab --url "*://*.amazon.com/*"
  $ assistant browser chrome relay new-tab --url "https://example.com"
  $ assistant browser chrome relay evaluate --tab-id <id> --code "document.title"
  $ assistant browser chrome relay screenshot --tab-id <id>`,
  );

  const chrome = browser
    .command("chrome")
    .description("Chrome browser automation via the chrome-extension proxy");

  const relay = chrome
    .command("relay")
    .description(
      "Send a single CDP command to a Chrome tab via the chrome extension",
    );

  // -- find-tab --

  relay
    .command("find-tab")
    .description("Find a tab matching a URL glob pattern")
    .requiredOption(
      "--url <pattern>",
      "URL glob pattern to match (e.g. *://*.instagram.com/*)",
    )
    .action(async (opts: { url: string }) => {
      await actionFindTab(opts.url);
    });

  // -- new-tab --

  relay
    .command("new-tab")
    .description("Open a new tab with the given URL")
    .requiredOption("--url <url>", "URL to open in a new tab")
    .action(async (opts: { url: string }) => {
      await actionNewTab(opts.url);
    });

  // -- navigate --

  relay
    .command("navigate")
    .description("Navigate an existing tab to a new URL")
    .requiredOption("--tab-id <id>", "Target tab ID")
    .requiredOption("--url <url>", "URL to navigate to")
    .action(async (opts: { tabId: string; url: string }) => {
      await actionNavigate(opts.tabId, opts.url);
    });

  // -- evaluate --

  relay
    .command("evaluate")
    .description("Execute JavaScript in a Chrome tab")
    .requiredOption("--tab-id <id>", "Target tab ID")
    .option(
      "--code <script>",
      "JavaScript code to evaluate (or read from stdin)",
    )
    .action(async (opts: { tabId: string; code?: string }) => {
      let code: string;
      if (opts.code) {
        code = opts.code;
      } else if (process.stdin.isTTY) {
        emitError("No code provided. Use --code or pipe JavaScript via stdin.");
        return;
      } else {
        code = await readStdin();
      }
      await actionEvaluate(opts.tabId, code);
    });

  // -- get-cookies --

  relay
    .command("get-cookies")
    .description("Fetch cookies for a domain")
    .requiredOption("--domain <domain>", "Cookie domain to fetch")
    .action(async (opts: { domain: string }) => {
      await actionGetCookies(opts.domain);
    });

  // -- set-cookie --

  relay
    .command("set-cookie")
    .description("Set a cookie in the browser")
    .requiredOption("--cookie <json>", "Cookie specification as JSON")
    .action(async (opts: { cookie: string }) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(opts.cookie) as Record<string, unknown>;
      } catch {
        emitError("Invalid JSON in --cookie argument");
        return;
      }
      await actionSetCookie(parsed);
    });

  // -- screenshot --

  relay
    .command("screenshot")
    .description("Capture a base64-encoded PNG screenshot of a Chrome tab")
    .option("--tab-id <id>", "Target tab ID (defaults to active tab)")
    .action(async (opts: { tabId?: string }) => {
      await actionScreenshot(opts.tabId);
    });
}
