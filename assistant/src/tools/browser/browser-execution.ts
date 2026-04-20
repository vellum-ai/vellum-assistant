import { getConfig } from "../../config/loader.js";
import type { ImageContent } from "../../providers/types.js";
import { getLogger } from "../../util/logger.js";
import { truncate } from "../../util/truncate.js";
import { safeStringSlice } from "../../util/unicode.js";
import { credentialBroker } from "../credentials/broker.js";
import { BROWSER_FILL_CAPABILITY } from "../credentials/tool-policy.js";
import {
  isPrivateOrLocalHost,
  parseUrl,
  resolveHostAddresses,
  resolveRequestAddress,
  sanitizeUrlForOutput,
} from "../network/url-safety.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";
import {
  detectAuthChallenge,
  detectCaptchaChallenge,
  formatAuthChallenge,
} from "./auth-detector.js";
import type { RouteHandler } from "./browser-manager.js";
import { browserManager } from "./browser-manager.js";
import { type BrowserMode, normalizeBrowserMode } from "./browser-mode.js";
import { BROWSER_MODE } from "./browser-mode-constants.js";
import {
  ensureScreencast,
  getSender,
  stopAllScreencasts,
  stopBrowserScreencast,
} from "./browser-screencast.js";
import {
  BROWSER_STATUS_INPUT_FIELD,
  BROWSER_STATUS_MODE,
  BROWSER_STATUS_MODES,
  type BrowserStatusMode,
  CDP_INSPECT_STATUS_DISCOVERY_CODE,
  EXTENSION_STATUS_ERROR_MARKER,
} from "./browser-status-constants.js";
import {
  formatAxSnapshot,
  transformAxTree,
} from "./cdp-client/accessibility-snapshot.js";
import {
  captureScreenshotJpeg,
  dispatchClickAt,
  dispatchHoverAt,
  dispatchInsertText,
  dispatchKeyPress,
  dispatchWheelScroll,
  evaluateExpression,
  focusElement,
  getCenterPoint,
  getCurrentUrl,
  getPageTitle,
  navigateAndWait,
  querySelectorBackendNodeId,
  scrollIntoViewIfNeeded,
  waitForSelector as cdpWaitForSelector,
  waitForText as cdpWaitForText,
} from "./cdp-client/cdp-dom-helpers.js";
import { CdpError } from "./cdp-client/errors.js";
import {
  buildCandidateList,
  getCdpClient,
  isDesktopAutoCooldownActive,
} from "./cdp-client/factory.js";
import type {
  AttemptDiagnostic,
  CdpClient,
  CdpClientKind,
} from "./cdp-client/types.js";
import { checkBrowserRuntime } from "./runtime-check.js";

const log = getLogger("headless-browser");

// ── Constants ────────────────────────────────────────────────────────

export const NAVIGATE_TIMEOUT_MS = 15_000;

export const ACTION_TIMEOUT_MS = 10_000;

export const MAX_WAIT_MS = 30_000;

export const MAX_EXTRACT_LENGTH = 50_000;

type StatusCheckMode = BrowserStatusMode;

const MODE_TRADEOFFS: Record<StatusCheckMode, string[]> = {
  [BROWSER_STATUS_MODE.EXTENSION]: [
    "This is the preferred approach for all things browser-use.",
    "It requires a one-time install of the Vellum Assistant Chrome Extension.",
    "More secure than relying on Chrome's native remote debugging functionality.",
    "Requires the Vellum extension to be paired and actively connected.",
  ],
  [BROWSER_STATUS_MODE.CDP_INSPECT]: [
    "This is the second-best approach for all things browser-use, after the native Vellum Assistant Chrome Extension.",
    "It requires Chrome version 146 or greater",
    "It requires toggling on remote debugging in Chrome Settings",
    "It's prone to phishing attacks from other local processes that may try to do their own remote debugging.",
  ],
  [BROWSER_STATUS_MODE.LOCAL]: [
    "The least-preferred approach for all things browser-use.",
    "Considered a last-resort fallback if the user has not installed the Chrome Extension or enabled remote debugging in Chrome, and has indicated that they do not want to.",
    "Does not use the user's existing browser profile, so sessions/cookies may differ.",
    "Requires that Playwright and Chromium are installed on the host machine,",
  ],
};

interface BrowserStatusModeResult {
  mode: StatusCheckMode;
  available: boolean;
  verified: "active_probe" | "preflight";
  autoCandidate: boolean;
  summary: string;
  userActions: string[];
  tradeoffs: string[];
  details: Record<string, unknown>;
}

/**
 * IIFE evaluated inside the page via `Runtime.evaluate` to auto-dismiss
 * common blocker modals (regulatory notices, cookie banners) that
 * aren't exposed in the accessibility tree. Runs silently - if no
 * matching modal is present the expression is a no-op.
 */
const DISMISS_MODALS_EXPRESSION = `(() => {
  const dismissPatterns = /^(got it|accept|ok|dismiss|i understand|close)$/i;
  const buttons = document.querySelectorAll('button, [role="button"], input[type="submit"]');
  for (const btn of buttons) {
    const text = (btn.textContent || '').trim();
    if (dismissPatterns.test(text)) {
      const modal = btn.closest('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="overlay"], [class*="Overlay"]');
      if (modal) {
        btn.click();
        break;
      }
    }
  }
})()`;

/**
 * IIFE evaluated by {@link executeBrowserExtract} when `include_links`
 * is true. Walks `document.querySelectorAll('a[href]')`, caps at 200
 * anchors, and shapes each entry as `{ text, href }`. Extracted to a
 * module-level constant so the expression is shared between the
 * runtime call site and any future refactors / tests that need to
 * reason about the evaluated source.
 */
export const EXTRACT_LINKS_EXPRESSION = `
(() => {
  const anchors = Array.from(document.querySelectorAll('a[href]'));
  return anchors.slice(0, 200).map(a => ({
    text: (a.textContent || '').trim().slice(0, 80),
    href: a.href,
  }));
})()
`;

// ── browser_mode parsing ─────────────────────────────────────────────

/**
 * Parse the `browser_mode` field from a tool input map. Returns either
 * a normalized {@link BrowserMode} or a pre-formatted error string
 * suitable for returning directly in a tool response.
 *
 * When the value is absent, undefined, or empty the default `"auto"`
 * is returned. Invalid values produce a descriptive error listing
 * accepted values and aliases.
 */
export function parseBrowserMode(
  input: Record<string, unknown>,
): { ok: true; mode: BrowserMode } | { ok: false; error: string } {
  const raw = input.browser_mode;
  const result = normalizeBrowserMode(raw);
  if ("error" in result) {
    return { ok: false, error: `Error: ${result.error}` };
  }
  return { ok: true, mode: result.mode };
}

// ── Mode-selection failure formatter ─────────────────────────────────

/**
 * Remediation hints keyed by (candidateKind, discoveryCode | errorCode).
 * Discovery codes come from DevToolsDiscoveryError; error codes come
 * from CdpError. The formatter walks these in priority order: exact
 * (kind, discoveryCode) first, then (kind, errorCode), then a generic
 * per-kind fallback.
 */
const REMEDIATION_HINTS: Record<string, string[]> = {
  // Extension backend
  "extension:transport_error": [
    "Ensure the Vellum browser extension is installed and enabled.",
    "Check that the extension WebSocket connection is active (extension popup → status).",
    "Try reconnecting the extension or reloading the extension service worker.",
  ],
  // cdp-inspect backend — discovery-level failures
  "cdp-inspect:unreachable": [
    "Ensure that Chrome is on version 146 or higher by going to chrome://settings/help.",
    'Ensure that you have toggled on "Allow remote debugging for this browser instance" by going to chrome://inspect/#remote-debugging',
    "Verify no firewall or antivirus is blocking localhost:9222.",
  ],
  "cdp-inspect:non_chrome": [
    "The process listening on the configured port is not Chrome/Chromium.",
    "Check if another application (dev server, proxy) is using port 9222.",
    "Ensure Chrome is launched with --remote-debugging-port=9222.",
  ],
  "cdp-inspect:timeout": [
    "Chrome DevTools endpoint did not respond within the probe timeout.",
    "Ensure Chrome is running and listening on the configured port.",
    "Try increasing hostBrowser.cdpInspect.probeTimeoutMs in config.",
  ],
  "cdp-inspect:no_targets": [
    "Chrome is reachable but has no open page targets.",
    "Open at least one browser tab, then retry.",
  ],
  "cdp-inspect:non_loopback": [
    "CDP inspect only allows loopback hosts (localhost, 127.0.0.1, ::1).",
    "Update hostBrowser.cdpInspect.host in config to a loopback address.",
  ],
  "cdp-inspect:transport_error": [
    "CDP endpoint unreachable. Ensure Chrome is running with --remote-debugging-port.",
    "Verify the configured host:port matches Chrome's DevTools listener.",
    "Consider using browser_mode: 'extension' or 'local' as an alternative.",
  ],
  // Local/Playwright backend
  "local:transport_error": [
    "The local Playwright-managed browser failed to start or connect.",
    "Check that the Playwright browser binary is downloaded (bun run install).",
    "Try closing any stale Chromium processes and retrying.",
  ],
};

/**
 * Build a human-readable, tool-response-ready error string from a
 * pinned-mode failure. Includes:
 *   - the requested mode
 *   - ordered attempted modes with exact failure reasons
 *   - a remediation checklist tailored by backend and failure code
 *
 * Exported for testing.
 */
export function formatModeSelectionFailure(
  requestedMode: BrowserMode,
  error: CdpError,
): string {
  const lines: string[] = [];
  lines.push(`Error: Browser mode "${requestedMode}" failed.`);
  lines.push("");

  const diagnostics: readonly AttemptDiagnostic[] =
    error.attemptDiagnostics ?? [];

  if (diagnostics.length > 0) {
    lines.push("Attempted backends:");
    for (const diag of diagnostics) {
      const status =
        diag.stage === "success" ? "OK" : `FAILED at ${diag.stage}`;
      lines.push(`  - ${diag.candidateKind}: ${status}`);
      if (diag.errorMessage) {
        lines.push(`    Reason: ${diag.errorMessage}`);
      }
      if (diag.discoveryCode) {
        lines.push(`    Discovery code: ${diag.discoveryCode}`);
      }
    }
    lines.push("");
  }

  // Collect remediation hints
  const hints = collectRemediationHints(diagnostics, error);
  if (hints.length > 0) {
    lines.push("Remediation:");
    for (const hint of hints) {
      lines.push(`  - ${hint}`);
    }
  }

  return lines.join("\n");
}

/**
 * Gather remediation hints based on attempt diagnostics and the error.
 * Walks each diagnostic and looks up hints by (kind, discoveryCode),
 * then (kind, errorCode), then generic kind-level fallback.
 */
function collectRemediationHints(
  diagnostics: readonly AttemptDiagnostic[],
  error: CdpError,
): string[] {
  const seen = new Set<string>();
  const hints: string[] = [];

  const addHints = (key: string) => {
    const list = REMEDIATION_HINTS[key];
    if (!list) return;
    for (const hint of list) {
      if (!seen.has(hint)) {
        seen.add(hint);
        hints.push(hint);
      }
    }
  };

  for (const diag of diagnostics) {
    if (diag.stage === "success") continue;
    if (diag.discoveryCode) {
      addHints(`${diag.candidateKind}:${diag.discoveryCode}`);
    }
    if (diag.errorCode) {
      addHints(`${diag.candidateKind}:${diag.errorCode}`);
    }
  }

  // Fallback: if no diagnostics but we have a top-level error, use
  // the error code with a generic candidate kind derived from the mode.
  if (diagnostics.length === 0 && error.code) {
    // Try to infer the candidate kind from the error message
    for (const kind of BROWSER_STATUS_MODES) {
      if (error.message.toLowerCase().includes(kind)) {
        addHints(`${kind}:${error.code}`);
      }
    }
  }

  return hints;
}

/**
 * Detect the common extension CDP failure where the active tab is a
 * restricted Chrome internal page (e.g. `chrome://newtab`).
 */
function isRestrictedChromePageProbeError(error: CdpError): boolean {
  return error.message.toLowerCase().includes("chrome://");
}

/**
 * Parse browser_mode from input and acquire a CdpClient. Returns
 * either a `{ cdp, browserMode }` pair on success or a pre-formatted
 * `{ errorResult }` on failure (invalid mode or pinned-mode
 * precondition not met).
 *
 * This is the single integration point for all CDP-backed tool
 * functions. Using it ensures every tool:
 *   - normalizes aliases (`cdp-debugger` -> `cdp-inspect`, etc.)
 *   - passes the mode preference to the factory
 *   - surfaces a remediation-rich error on pinned-mode failures
 *
 * Per-conversation stickiness: when the incoming `browser_mode` is
 * `"auto"` and the conversation has already resolved to a backend
 * kind on a prior call, the factory is pinned to that kind instead
 * of re-running the auto priority list. This prevents
 * `browser_navigate` (e.g. pinned to `local`) and `browser_screenshot`
 * (default auto) in the same conversation from landing on different
 * Chrome instances. Explicit non-auto modes override and update the
 * memo; teardown via browser_close / browser_detach clears it.
 *
 * The returned client is wrapped so its first successful `send()`
 * writes the resolved kind back to the conversation memo.
 */
export function acquireCdpClientWithMode(
  input: Record<string, unknown>,
  context: ToolContext,
):
  | {
      cdp: ReturnType<typeof getCdpClient>;
      browserMode: BrowserMode;
      errorResult?: never;
    }
  | { cdp?: never; browserMode?: never; errorResult: ToolExecutionResult } {
  const modeResult = parseBrowserMode(input);
  if (!modeResult.ok) {
    return {
      errorResult: { content: modeResult.error, isError: true },
    };
  }
  const browserMode = modeResult.mode;

  const rememberedKind = browserManager.getPreferredBackendKind(
    context.conversationId,
  );
  const effectiveMode: BrowserMode =
    browserMode === "auto" && rememberedKind !== null
      ? rememberedKind
      : browserMode;

  try {
    const raw = getCdpClient(context, { mode: effectiveMode });
    const cdp = wrapWithKindMemo(raw, context.conversationId);
    return { cdp, browserMode };
  } catch (err) {
    // Sticky-mode fallback: the caller requested "auto" but we pinned to
    // a remembered backend kind that has since become unavailable. Drop
    // the stale memo and retry with fresh auto selection so a dead
    // sticky preference doesn't surface as a hard failure.
    if (browserMode === "auto" && effectiveMode !== "auto") {
      browserManager.clearPreferredBackendKind(context.conversationId);
      try {
        const raw = getCdpClient(context, { mode: "auto" });
        const cdp = wrapWithKindMemo(raw, context.conversationId);
        return { cdp, browserMode };
      } catch (retryErr) {
        if (retryErr instanceof CdpError) {
          return {
            errorResult: {
              content: formatModeSelectionFailure("auto", retryErr),
              isError: true,
            },
          };
        }
        throw retryErr;
      }
    }
    if (err instanceof CdpError && browserMode !== "auto") {
      return {
        errorResult: {
          content: formatModeSelectionFailure(browserMode, err),
          isError: true,
        },
      };
    }
    throw err;
  }
}

/**
 * Wrap a {@link ScopedCdpClient} so the first successful `send()`
 * records the resolved backend kind in the conversation's
 * `preferredBackendKinds` memo. Subsequent sends are no-ops for the
 * memo; dispose() delegates to the underlying client.
 */
function wrapWithKindMemo(
  inner: ReturnType<typeof getCdpClient>,
  conversationId: string,
): ReturnType<typeof getCdpClient> {
  let recorded = false;
  return {
    get kind() {
      return inner.kind;
    },
    conversationId: inner.conversationId,
    async send<T = unknown>(
      method: string,
      params?: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<T> {
      const result = await inner.send<T>(method, params, signal);
      if (!recorded) {
        browserManager.setPreferredBackendKind(conversationId, inner.kind);
        recorded = true;
      }
      return result;
    },
    dispose(): void {
      inner.dispose();
    },
  };
}

// ── CDP error diagnostics helper ─────────────────────────────────────

/**
 * Check whether a caught error is a {@link CdpError} carrying
 * {@link AttemptDiagnostic attempt diagnostics} from the factory's
 * failover walk. When the browser_mode is pinned (not "auto") and
 * diagnostics are present, format the error with the full remediation
 * checklist via {@link formatModeSelectionFailure}. Otherwise return
 * `null` so the caller falls through to its generic error message.
 *
 * This handles the case where pinned-mode unavailability is surfaced
 * on the first `cdp.send()` (via `sendWithFailover`) rather than
 * during client construction (which `acquireCdpClientWithMode` already
 * covers).
 */
function formatCdpSendDiagnostics(
  err: unknown,
  browserMode: BrowserMode,
): string | null {
  if (
    err instanceof CdpError &&
    browserMode !== "auto" &&
    err.code === "transport_error" &&
    err.attemptDiagnostics
  ) {
    return formatModeSelectionFailure(browserMode, err);
  }
  return null;
}

// ── Shared element resolution ────────────────────────────────────────

/**
 * Discriminated union returned by {@link resolveElement}. The
 * `"backend"` variant is produced when an `element_id` from the most
 * recent AX-tree snapshot is resolved to a CDP `backendNodeId`; the
 * `"selector"` variant is produced when the caller passed a raw CSS
 * `selector` that should be resolved via `DOM.querySelector` at
 * send-time by the individual tool.
 *
 * Consumed by CDP-native interaction tools (click, hover, type, …)
 * that talk to CDP directly.
 */
export type ResolvedElement =
  | { kind: "backend"; backendNodeId: number; eid: string }
  | { kind: "selector"; selector: string };

/**
 * Resolve an element reference (either `element_id` from a prior
 * snapshot or a raw `selector`) for CDP-native tools. Returns a
 * {@link ResolvedElement} discriminated union so callers can branch
 * on whether a backendNodeId was recovered from the snapshot map.
 * Returns `{ resolved: null, error: "Error: …" }` on invalid input
 * or when an `element_id` is provided but the snapshot map is
 * empty/stale.
 */
export function resolveElement(
  conversationId: string,
  input: Record<string, unknown>,
): { resolved: ResolvedElement | null; error: string | null } {
  const elementId =
    typeof input.element_id === "string" ? input.element_id : null;
  const rawSelector =
    typeof input.selector === "string" ? input.selector : null;

  if (!elementId && !rawSelector) {
    return {
      resolved: null,
      error: "Error: Either element_id or selector is required.",
    };
  }

  if (elementId) {
    const backendNodeId = browserManager.resolveSnapshotBackendNodeId(
      conversationId,
      elementId,
    );
    if (backendNodeId !== null) {
      return {
        resolved: { kind: "backend", backendNodeId, eid: elementId },
        error: null,
      };
    }
    return {
      resolved: null,
      error: `Error: element_id "${elementId}" not found. Run a snapshot first to get current element IDs.`,
    };
  }

  return {
    resolved: { kind: "selector", selector: rawSelector! },
    error: null,
  };
}

// ── browser_navigate ─────────────────────────────────────────────────

export async function executeBrowserNavigate(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  if (context.signal?.aborted) {
    return { content: "Error: operation was cancelled", isError: true };
  }

  // Pre-flight URL validation runs before CDP acquisition so we fail
  // fast on obviously invalid URLs without opening a browser session.
  const parsedUrl = parseUrl(input.url);
  if (!parsedUrl) {
    return {
      content: "Error: url is required and must be a valid HTTP(S) URL",
      isError: true,
    };
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return { content: "Error: url must use http or https", isError: true };
  }

  const allowPrivateNetwork = input.allow_private_network === true;
  const safeRequestedUrl = sanitizeUrlForOutput(parsedUrl);

  // Block private/local targets by default. Runs before any CDP session
  // is opened so we fail fast on obviously invalid URLs.
  if (!allowPrivateNetwork && isPrivateOrLocalHost(parsedUrl.hostname)) {
    return {
      content: `Error: Refusing to navigate to local/private network target (${parsedUrl.hostname}). Set allow_private_network=true if you explicitly need it.`,
      isError: true,
    };
  }

  // DNS resolution check for non-literal hostnames.
  if (!allowPrivateNetwork) {
    const resolution = await resolveRequestAddress(
      parsedUrl.hostname,
      resolveHostAddresses,
      allowPrivateNetwork,
    );
    if (resolution.blockedAddress) {
      return {
        content: `Error: Refusing to navigate to target (${parsedUrl.hostname}) because it resolves to local/private network address ${resolution.blockedAddress}. Set allow_private_network=true if you explicitly need it.`,
        isError: true,
      };
    }
  }

  // URL validation passed — acquire the CDP client.
  const acquired = acquireCdpClientWithMode(input, context);
  if (acquired.errorResult) return acquired.errorResult;
  const { cdp, browserMode } = acquired;

  // Screencast + handoff are Playwright-backed and only meaningful
  // for the local sacrificial-profile path. On the extension path the
  // user already has their own Chrome window, so both are no-ops.
  const sender =
    cdp.kind === "local" ? getSender(context.conversationId) : null;
  if (cdp.kind === "local" && sender) {
    await ensureScreencast(context.conversationId);
  }

  // SSRF route interception uses the Playwright page.route() API to
  // block redirect-time requests to private networks. This only works
  // on the local path where Playwright manages the browser; on the
  // extension/cdp-inspect paths, CDP navigates a different browser so
  // the Playwright route handler would be a no-op. The post-navigation
  // final URL check below provides defense-in-depth for all paths.
  let routeHandler: RouteHandler | null = null;
  let blockedUrl: string | null = null;

  try {
    log.debug(
      { url: safeRequestedUrl, conversationId: context.conversationId },
      "Navigating",
    );

    if (
      cdp.kind === "local" &&
      !allowPrivateNetwork &&
      browserManager.supportsRouteInterception
    ) {
      // Cache DNS results per-hostname to avoid redundant lookups on subrequests
      // (heavy sites like DoorDash fire hundreds of requests to the same CDN hostnames).
      // Use a short TTL to mitigate DNS rebinding attacks where a hostname first
      // resolves to a public IP then later to a private one. Blocked results are
      // never cached so they are always re-resolved.
      const DNS_CACHE_TTL_MS = 5_000;
      const dnsCache = new Map<
        string,
        { addresses: string[]; blockedAddress?: string; cachedAt: number }
      >();
      routeHandler = async (route, request) => {
        try {
          const reqUrl = request.url();
          let reqParsed: URL;
          try {
            reqParsed = new URL(reqUrl);
          } catch {
            await route.continue();
            return;
          }

          // Check hostname against private/local patterns
          if (isPrivateOrLocalHost(reqParsed.hostname)) {
            blockedUrl = sanitizeUrlForOutput(reqParsed);
            log.warn(
              { blockedUrl },
              "Blocked navigation to private network target via redirect",
            );
            await route.abort("blockedbyclient");
            return;
          }

          // Resolve DNS and check resolved addresses (cached per hostname with TTL).
          // Blocked results are never cached to ensure re-resolution catches
          // DNS rebinding where a hostname flips from public to private IP.
          let cached = dnsCache.get(reqParsed.hostname);
          const now = Date.now();
          if (cached && now - cached.cachedAt > DNS_CACHE_TTL_MS) {
            dnsCache.delete(reqParsed.hostname);
            cached = undefined;
          }
          const resolution =
            cached ??
            (await (async () => {
              const res = await resolveRequestAddress(
                reqParsed.hostname,
                resolveHostAddresses,
                false,
              );
              // Only cache allowed results; blocked results must be re-resolved
              if (!res.blockedAddress) {
                dnsCache.set(reqParsed.hostname, { ...res, cachedAt: now });
              }
              return res;
            })());
          if (resolution.blockedAddress) {
            blockedUrl = sanitizeUrlForOutput(reqParsed);
            log.warn(
              { blockedUrl, resolvedTo: resolution.blockedAddress },
              "Blocked navigation: DNS resolves to private address",
            );
            await route.abort("blockedbyclient");
            return;
          }

          await route.continue();
        } catch (err) {
          // Route may already be handled if the page navigated or was closed
          log.debug(
            { err },
            "Route handler error (route likely already handled)",
          );
        }
      };
      // Bridge through browserManager to reach the Playwright Page for
      // route installation. The route handler intercepts redirect-time
      // requests before Page.navigate's network fetches can hit them.
      const page = await browserManager.getOrCreateSessionPage(
        context.conversationId,
      );
      await page.route("**/*", routeHandler);
    }

    // Read the current URL BEFORE calling navigateAndWait so we can
    // detect the "page never moved" case on timeout.
    const urlBeforeNav = await getCurrentUrl(cdp, context.signal);

    // Navigate via CDP Page.navigate + document.readyState polling.
    // navigateAndWait returns { finalUrl, timedOut }; HTTP status is
    // not available on the CDP path because Page.navigate does not
    // surface the response status.
    const { finalUrl, timedOut: navigationTimedOut } = await navigateAndWait(
      cdp,
      parsedUrl.href,
      { timeoutMs: NAVIGATE_TIMEOUT_MS },
      context.signal,
    );

    // Defense-in-depth: check the final URL after navigation completes.
    // This catches redirect-based SSRF even when Playwright route
    // interception is unavailable (e.g. extension-backed sessions where
    // the CDP transport is separate from the Playwright page).
    if (!allowPrivateNetwork) {
      const finalParsed = parseUrl(finalUrl);
      if (
        finalParsed &&
        (isPrivateOrLocalHost(finalParsed.hostname) ||
          (
            await resolveRequestAddress(
              finalParsed.hostname,
              resolveHostAddresses,
              false,
            )
          ).blockedAddress)
      ) {
        // Navigate the page away from the private target to prevent
        // follow-up operations (e.g. snapshot) from reading the
        // already-loaded private content.
        try {
          await navigateAndWait(
            cdp,
            "about:blank",
            { timeoutMs: 3_000 },
            context.signal,
          );
        } catch {
          // Best-effort — if the reset fails, the CDP session will be
          // disposed in the finally block anyway.
        }
        // Clean up the route handler before returning to avoid leaking
        // a stale interception handler on the session page.
        if (routeHandler) {
          const page = await browserManager.getOrCreateSessionPage(
            context.conversationId,
          );
          await page.unroute("**/*", routeHandler);
          routeHandler = null;
        }
        return {
          content: `Error: Navigation blocked. Final URL resolved to a local/private network target (${sanitizeUrlForOutput(finalParsed)}). Set allow_private_network=true if you explicitly need it.`,
          isError: true,
        };
      }
    }
    if (navigationTimedOut) {
      // If the page URL never changed from before navigation, the page
      // never actually loaded - re-throw instead of reporting success.
      if (finalUrl === urlBeforeNav && urlBeforeNav !== parsedUrl.href) {
        throw new Error(
          `Navigation to ${parsedUrl.href} timed out after ${NAVIGATE_TIMEOUT_MS}ms`,
        );
      }
      log.info(
        { url: safeRequestedUrl },
        "Navigation timed out waiting for document.readyState, continuing with partial load",
      );
    }

    // Remove the Playwright route handler now that navigation is
    // complete (local path only — route interception is gated above).
    if (routeHandler) {
      const page = await browserManager.getOrCreateSessionPage(
        context.conversationId,
      );
      await page.unroute("**/*", routeHandler);
      routeHandler = null;
    }

    // Window positioning is a Playwright-internal affordance - on the
    // extension path the user owns their Chrome window, so positioning
    // is a no-op.
    if (
      cdp.kind === "local" &&
      !browserManager.isInteractive(context.conversationId)
    ) {
      await browserManager.positionWindowSidebar();
    }

    if (blockedUrl) {
      return {
        content: `Error: Navigation blocked. A request targeted a local/private network address (${blockedUrl}). Set allow_private_network=true if you explicitly need it.`,
        isError: true,
      };
    }

    // Navigation changed the page content, so clear stale snapshot
    // mappings regardless of backend. The backendNodeId map is shared
    // per-conversation state that needs to be invalidated on any nav.
    browserManager.clearSnapshotBackendNodeMap(context.conversationId);

    // Auto-dismiss common blocker modals (regulatory notices, cookie
    // banners) that aren't exposed in the accessibility tree. Runs
    // silently - if no modal is present the evaluate is a no-op.
    try {
      await evaluateExpression(
        cdp,
        DISMISS_MODALS_EXPRESSION,
        {},
        context.signal,
      );
    } catch {
      // Page may have navigated during evaluate - safe to ignore
    }

    const safeFinalUrl = sanitizeUrlForOutput(new URL(finalUrl));
    const title = await getPageTitle(cdp, context.signal);
    // HTTP status is not available on the CDP path: `Page.navigate`
    // resolves the frame id and (on failure) an error text, but does
    // not carry the response status code. Both the local and extension
    // paths therefore print "unknown" here. A future phase may subscribe
    // to `Network.responseReceived` events during the navigation window
    // if the status is needed again.
    const status: number | null = null;

    const lines: string[] = [
      `Requested URL: ${safeRequestedUrl}`,
      `Final URL: ${safeFinalUrl}`,
      `Status: ${status ?? "unknown"}`,
      `Title: ${title || "(none)"}`,
    ];

    if (navigationTimedOut) {
      lines.push(
        `Note: Page is still loading (document.readyState timed out). The page should still be interactive - take a snapshot to check.`,
      );
    }

    if (finalUrl !== parsedUrl.href) {
      lines.push(`Note: Page redirected from the requested URL.`);
    }

    // Detect auth challenges (login pages, 2FA, OAuth consent) and CAPTCHA
    // challenges via the CDP-migrated auth-detector helpers.
    try {
      const authChallenge = await detectAuthChallenge(cdp, context.signal);
      const captchaChallenge = await detectCaptchaChallenge(
        cdp,
        context.signal,
      );
      // CAPTCHA takes priority - it blocks all interaction including login
      let challenge = captchaChallenge ?? authChallenge;

      // Many CAPTCHA interstitials (e.g. Cloudflare "Just a moment") auto-resolve
      // within a few seconds. Wait and re-check before handing off to the user.
      if (challenge?.type === "captcha") {
        log.info("CAPTCHA detected, waiting up to 5s for auto-resolve");
        for (let i = 0; i < 5; i++) {
          if (context.signal?.aborted) {
            return { content: "Navigation cancelled.", isError: true };
          }
          await new Promise((r) => setTimeout(r, 1000));
          const still = await detectCaptchaChallenge(cdp, context.signal);
          if (!still) {
            log.info("CAPTCHA auto-resolved");
            // Re-check for auth challenge now that CAPTCHA is gone -
            // the page may have loaded a login form behind it.
            challenge = await detectAuthChallenge(cdp, context.signal);
            break;
          }
        }
      }

      if (challenge) {
        if (challenge.type === "captcha") {
          // CAPTCHA persisted after auto-resolve wait - hand off to user
          // only when we have a local Playwright-managed Chrome window
          // AND a sender is registered. The extension path falls back
          // to the text-only "solve manually" branch because the user
          // already owns their Chrome window.
          if (cdp.kind === "local" && sender) {
            const { startHandoff } = await import("./browser-handoff.js");
            await startHandoff(context.conversationId, {
              reason: "captcha",
              message:
                "Cloudflare verification detected. Please solve the CAPTCHA in the Chrome window. The browser will automatically detect when you're done and resume.",
              bringToFront: true,
            });
            const newUrl = await getCurrentUrl(cdp, context.signal);
            const newTitle = await getPageTitle(cdp, context.signal);
            lines.push("");
            lines.push(
              `CAPTCHA solved by user. Current page: ${newTitle} (${newUrl})`,
            );

            // Re-check for auth challenges - the page behind the CAPTCHA may have a login form
            const postCaptchaAuth = await detectAuthChallenge(
              cdp,
              context.signal,
            );
            if (postCaptchaAuth) {
              lines.push("");
              lines.push(formatAuthChallenge(postCaptchaAuth));
              lines.push("");
              lines.push("Handle this by interacting with the login form:");
              lines.push(
                "1. Take a snapshot to find the sign-in form elements",
              );
              lines.push(
                "2. Use credential fill to enter email/password from credential_store",
              );
              lines.push(
                "3. For email verification codes, use ui_show with a form to ask the user for the code mid-turn",
              );
              lines.push(
                "4. Do NOT give up or tell the user to sign in manually - handle the login flow yourself",
              );
            }
          } else {
            lines.push("");
            lines.push(
              "⚠️ CAPTCHA/Cloudflare verification detected on this page.",
            );
            lines.push(
              "The user needs to solve this challenge manually. Please inform the user that the page requires human verification before the content can be accessed.",
            );
          }
        } else {
          // Login / 2FA / OAuth - the agent should handle these itself
          // using browser operations + credential_store. Don't hand off.
          lines.push("");
          lines.push(formatAuthChallenge(challenge));
          lines.push("");
          lines.push("Handle this by interacting with the login form:");
          lines.push("1. Take a snapshot to find the sign-in form elements");
          lines.push(
            "2. Use credential fill to enter email/password from credential_store",
          );
          lines.push(
            "3. For email verification codes, use ui_show with a form to ask the user for the code mid-turn",
          );
          lines.push(
            "4. Do NOT give up or tell the user to sign in manually - handle the login flow yourself",
          );
        }
      }
    } catch {
      // Auth/CAPTCHA detection is best-effort; don't fail navigation
    }

    return { content: lines.join("\n"), isError: false };
  } catch (err) {
    // Best-effort cleanup of route handler on error (local path only)
    if (routeHandler) {
      try {
        const page = await browserManager.getOrCreateSessionPage(
          context.conversationId,
        );
        await page.unroute("**/*", routeHandler);
      } catch {
        /* ignore cleanup errors */
      }
    }

    // If the route handler blocked a redirect to a private network address,
    // Page.navigate throws. Return the clear security message instead of
    // the raw underlying error (which could leak credentials from the URL).
    if (blockedUrl) {
      return {
        content: `Error: Navigation blocked. A request targeted a local/private network address (${blockedUrl}). Set allow_private_network=true if you explicitly need it.`,
        isError: true,
      };
    }

    const diagnosticMessage = formatCdpSendDiagnostics(err, browserMode);
    if (diagnosticMessage) {
      return { content: diagnosticMessage, isError: true };
    }

    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, url: safeRequestedUrl }, "Navigation failed");
    return { content: `Error: Navigation failed: ${msg}`, isError: true };
  } finally {
    cdp.dispose();
  }
}

// ── snapshot ─────────────────────────────────────────────────────────

export async function executeBrowserSnapshot(
  _input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const acquired = acquireCdpClientWithMode(_input, context);
  if (acquired.errorResult) return acquired.errorResult;
  const { cdp, browserMode } = acquired;

  try {
    const currentUrl = await getCurrentUrl(cdp, context.signal);
    const title = await getPageTitle(cdp, context.signal);

    // Pull the full accessibility tree via CDP and fold it into typed
    // interactive elements + an `eid → backendNodeId` map. Interaction
    // tools (click, hover, type, …) resolve element_id against this map
    // and jump straight to CDP DOM commands without another round-trip
    // through any selector engine.
    await cdp.send("Accessibility.enable", {}, context.signal);
    const rawTree = await cdp.send(
      "Accessibility.getFullAXTree",
      {},
      context.signal,
    );
    const { elements, selectorMap: backendNodeMap } = transformAxTree(rawTree);

    browserManager.storeSnapshotBackendNodeMap(
      context.conversationId,
      backendNodeMap,
    );

    return {
      content: formatAxSnapshot(
        { elements, selectorMap: backendNodeMap },
        { url: currentUrl, title },
      ),
      isError: false,
    };
  } catch (err) {
    const diagnosticMessage = formatCdpSendDiagnostics(err, browserMode);
    if (diagnosticMessage) {
      return { content: diagnosticMessage, isError: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Snapshot failed");
    return { content: `Error: Snapshot failed: ${msg}`, isError: true };
  } finally {
    cdp.dispose();
  }
}

// ── browser_screenshot ───────────────────────────────────────────────

export async function executeBrowserScreenshot(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const acquired = acquireCdpClientWithMode(input, context);
  if (acquired.errorResult) return acquired.errorResult;
  const { cdp, browserMode } = acquired;
  const fullPage = input.full_page === true;

  try {
    const buffer = await captureScreenshotJpeg(
      cdp,
      { quality: 80, fullPage },
      context.signal,
    );
    const base64Data = buffer.toString("base64");

    const imageBlock: ImageContent = {
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: "image/jpeg",
        data: base64Data,
      },
    };

    return {
      content: `Screenshot captured (${buffer.length} bytes, ${
        fullPage ? "full page" : "viewport"
      })`,
      isError: false,
      contentBlocks: [imageBlock],
    };
  } catch (err) {
    const diagnosticMessage = formatCdpSendDiagnostics(err, browserMode);
    if (diagnosticMessage) {
      return { content: diagnosticMessage, isError: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Screenshot failed");
    return { content: `Error: Screenshot failed: ${msg}`, isError: true };
  } finally {
    cdp.dispose();
  }
}

// ── browser_attach ───────────────────────────────────────────────────

export async function executeBrowserAttach(
  _input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const acquired = acquireCdpClientWithMode(_input, context);
  if (acquired.errorResult) return acquired.errorResult;
  const cdp = acquired.cdp;
  try {
    if (cdp.kind === "extension") {
      // Extension path: explicitly attach the debugger via a synthetic
      // Vellum.attach command so the debugging session is established
      // before any navigation or interaction.
      const result = await cdp.send<{ attached?: boolean; target?: unknown }>(
        "Vellum.attach",
        {},
        context.signal,
      );
      log.debug(
        { conversationId: context.conversationId, result },
        "Browser debugger attached (extension)",
      );
      return {
        content: "Browser debugger attached.",
        isError: false,
      };
    }

    // Non-extension backends (local / cdp-inspect): explicit attach is
    // not required — the backend manages its own connection lifecycle.
    // Return a deterministic no-op success.
    return {
      content:
        "Browser session ready. (Explicit attach is not required on this backend.)",
      isError: false,
    };
  } catch (err) {
    const diagnosticMessage = formatCdpSendDiagnostics(
      err,
      acquired.browserMode,
    );
    if (diagnosticMessage) {
      return { content: diagnosticMessage, isError: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Attach failed");
    return { content: `Error: Attach failed: ${msg}`, isError: true };
  } finally {
    cdp.dispose();
  }
}

// ── browser_detach ──────────────────────────────────────────────────

export async function executeBrowserDetach(
  _input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const acquired = acquireCdpClientWithMode(_input, context);
  if (acquired.errorResult) return acquired.errorResult;
  const cdp = acquired.cdp;
  try {
    if (cdp.kind === "extension") {
      // Extension path: explicitly detach the debugger via a synthetic
      // Vellum.detach command so the Chrome debugging banner clears.
      const result = await cdp.send<{ detached?: boolean; target?: unknown }>(
        "Vellum.detach",
        {},
        context.signal,
      );
      log.debug(
        { conversationId: context.conversationId, result },
        "Browser debugger detached (extension)",
      );
    }

    return {
      content: "Browser debugger detached and snapshot state cleared.",
      isError: false,
    };
  } catch (err) {
    const diagnosticMessage = formatCdpSendDiagnostics(
      err,
      acquired.browserMode,
    );
    if (diagnosticMessage) {
      return { content: diagnosticMessage, isError: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Detach failed");
    return { content: `Error: Detach failed: ${msg}`, isError: true };
  } finally {
    // Always reset conversation-scoped browser state, even if the
    // Vellum.detach round-trip failed (target gone, transport dropped).
    // browser_detach is the user's recovery path — leaving a stale
    // sticky backend or snapshot map behind would defeat its purpose.
    browserManager.clearSnapshotBackendNodeMap(context.conversationId);
    browserManager.clearPreferredBackendKind(context.conversationId);
    cdp.dispose();
  }
}

// ── browser_close ────────────────────────────────────────────────────

export async function executeBrowserClose(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const acquired = acquireCdpClientWithMode(input, context);
  if (acquired.errorResult) return acquired.errorResult;
  const cdp = acquired.cdp;
  try {
    if (cdp.kind === "local") {
      // Local/sacrificial-profile path: tear down the Playwright page,
      // screencast, and associated CDP state for this conversation.
      const sender = getSender(context.conversationId);
      if (sender) {
        await stopBrowserScreencast(context.conversationId);
      }

      if (input.close_all_pages === true) {
        await stopAllScreencasts();
        await browserManager.closeAllPages();
        return {
          content: "All browser pages and context closed.",
          isError: false,
        };
      }
      await browserManager.closeSessionPage(context.conversationId);
      return {
        content: "Browser page closed for this conversation.",
        isError: false,
      };
    }

    // Extension path: the user owns their Chrome tab — we must not
    // close it. Detach the debugger (so the Chrome debugging banner
    // clears promptly) and drop the cached snapshot state so stale
    // eids from prior snapshots cannot be resolved by later tool calls.
    try {
      await cdp.send("Vellum.detach", {}, context.signal);
    } catch {
      // Tolerate detach failures (already detached, tab closed, etc.)
    }
    browserManager.clearSnapshotBackendNodeMap(context.conversationId);
    browserManager.clearPreferredBackendKind(context.conversationId);
    return {
      content:
        "Browser session cleared. (Your Chrome tab was not closed — close it yourself if desired.)",
      isError: false,
    };
  } catch (err) {
    const diagnosticMessage = formatCdpSendDiagnostics(
      err,
      acquired.browserMode,
    );
    if (diagnosticMessage) {
      return { content: diagnosticMessage, isError: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Close failed");
    return { content: `Error: Close failed: ${msg}`, isError: true };
  } finally {
    cdp.dispose();
  }
}

// ── browser_click ────────────────────────────────────────────────────

export async function executeBrowserClick(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const { resolved, error } = resolveElement(context.conversationId, input);
  if (error) return { content: error, isError: true };

  const acquired = acquireCdpClientWithMode(input, context);
  if (acquired.errorResult) return acquired.errorResult;
  const cdp = acquired.cdp;
  try {
    let backendNodeId: number;
    if (resolved!.kind === "backend") {
      backendNodeId = resolved!.backendNodeId;
    } else {
      // Wait until the selector matches a visible element. Mirrors
      // Playwright's `page.click(selector, { timeout })` semantics
      // and lets click work on async-hydrated pages where the
      // target may not yet exist when the tool is invoked.
      // cdpWaitForSelector returns the backendNodeId so we don't
      // need a separate querySelectorBackendNodeId round-trip.
      backendNodeId = await cdpWaitForSelector(
        cdp,
        resolved!.selector,
        ACTION_TIMEOUT_MS,
        context.signal,
      );
    }
    await scrollIntoViewIfNeeded(cdp, backendNodeId, context.signal);
    const point = await getCenterPoint(cdp, backendNodeId, context.signal);
    await dispatchClickAt(cdp, point, context.signal);
    const desc =
      resolved!.kind === "backend"
        ? `eid=${resolved!.eid}`
        : resolved!.selector;
    return { content: `Clicked element: ${desc}`, isError: false };
  } catch (err) {
    const diagnosticMessage = formatCdpSendDiagnostics(
      err,
      acquired.browserMode,
    );
    if (diagnosticMessage) {
      return { content: diagnosticMessage, isError: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Click failed");
    return { content: `Error: Click failed: ${msg}`, isError: true };
  } finally {
    cdp.dispose();
  }
}

// ── Shared input helpers ─────────────────────────────────────────────

/**
 * Focus an element, clear its existing value (handling both
 * `<input>`/`<textarea>` and `contentEditable` targets), re-focus
 * (sites sometimes blur on a programmatic value reset), and insert
 * the requested text via `Input.insertText`.
 *
 * Used by both `executeBrowserType` and `executeBrowserFillCredential`
 * so credential fills cannot append to autofilled / pre-populated
 * fields — appending would leak the existing value into the broker
 * payload and corrupt the resulting password.
 */
async function clearAndInsertText(
  cdp: CdpClient,
  backendNodeId: number,
  value: string,
  signal?: AbortSignal,
): Promise<void> {
  await focusElement(cdp, backendNodeId, signal);

  // Resolve the node to a Runtime.RemoteObject so we can invoke a
  // function on the element itself via Runtime.callFunctionOn. This
  // is more reliable than a keyboard select-all + delete sequence
  // across input, textarea, and contenteditable targets.
  const { object } = await cdp.send<{ object: { objectId: string } }>(
    "DOM.resolveNode",
    { backendNodeId },
    signal,
  );
  await cdp.send(
    "Runtime.callFunctionOn",
    {
      objectId: object.objectId,
      functionDeclaration: `function() {
        if (typeof this.value === "string") {
          this.value = "";
        } else if (this.isContentEditable) {
          this.textContent = "";
        }
        this.dispatchEvent(new Event("input", { bubbles: true }));
      }`,
      arguments: [],
    },
    signal,
  );

  // Re-focus after clearing — some sites move focus when the value
  // property is reassigned programmatically.
  await focusElement(cdp, backendNodeId, signal);

  await dispatchInsertText(cdp, value, signal);
}

// ── browser_type ─────────────────────────────────────────────────────

export async function executeBrowserType(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const { resolved, error } = resolveElement(context.conversationId, input);
  if (error) return { content: error, isError: true };

  const text = typeof input.text === "string" ? input.text : "";
  if (!text) {
    return { content: "Error: text is required.", isError: true };
  }

  const clearFirst = input.clear_first !== false; // default true
  const pressEnter = input.press_enter === true;

  const targetDescription =
    resolved!.kind === "backend"
      ? `element_id "${resolved!.eid}"`
      : resolved!.selector;

  const acquired = acquireCdpClientWithMode(input, context);
  if (acquired.errorResult) return acquired.errorResult;
  const cdp = acquired.cdp;
  try {
    let backendNodeId: number;
    if (resolved!.kind === "backend") {
      backendNodeId = resolved!.backendNodeId;
    } else {
      backendNodeId = await querySelectorBackendNodeId(
        cdp,
        resolved!.selector,
        context.signal,
      );
    }

    if (clearFirst) {
      await clearAndInsertText(cdp, backendNodeId, text, context.signal);
    } else {
      await focusElement(cdp, backendNodeId, context.signal);
      await dispatchInsertText(cdp, text, context.signal);
    }

    if (pressEnter) {
      await dispatchKeyPress(cdp, "Enter", context.signal);
    }

    const lines = [`Typed into element: ${targetDescription}`];
    if (clearFirst) lines.push("(cleared existing content first)");
    if (pressEnter) lines.push("(pressed Enter after typing)");
    return { content: lines.join("\n"), isError: false };
  } catch (err) {
    const diagnosticMessage = formatCdpSendDiagnostics(
      err,
      acquired.browserMode,
    );
    if (diagnosticMessage) {
      return { content: diagnosticMessage, isError: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, target: targetDescription }, "Type failed");
    return { content: `Error: Type failed: ${msg}`, isError: true };
  } finally {
    cdp.dispose();
  }
}

// ── browser_press_key ────────────────────────────────────────────────

export async function executeBrowserPressKey(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const key = typeof input.key === "string" ? input.key : "";
  if (!key) {
    return { content: "Error: key is required.", isError: true };
  }

  const elementId =
    typeof input.element_id === "string" ? input.element_id : null;
  const rawSelector =
    typeof input.selector === "string" ? input.selector : null;
  const hasTarget = elementId !== null || rawSelector !== null;

  let targetDescription: string | null = null;
  let resolved: ResolvedElement | null = null;
  if (hasTarget) {
    const res = resolveElement(context.conversationId, input);
    if (res.error) {
      return { content: res.error, isError: true };
    }
    resolved = res.resolved;
    targetDescription =
      resolved!.kind === "backend"
        ? `element_id "${resolved!.eid}"`
        : resolved!.selector;
  }

  const acquired = acquireCdpClientWithMode(input, context);
  if (acquired.errorResult) return acquired.errorResult;
  const cdp = acquired.cdp;
  try {
    if (resolved) {
      let backendNodeId: number;
      if (resolved.kind === "backend") {
        backendNodeId = resolved.backendNodeId;
      } else {
        backendNodeId = await querySelectorBackendNodeId(
          cdp,
          resolved.selector,
          context.signal,
        );
      }
      await focusElement(cdp, backendNodeId, context.signal);
      await dispatchKeyPress(cdp, key, context.signal);
      return {
        content: `Pressed "${key}" on element: ${targetDescription}`,
        isError: false,
      };
    }

    // No target -> press key on the currently focused element
    await dispatchKeyPress(cdp, key, context.signal);
    return { content: `Pressed "${key}"`, isError: false };
  } catch (err) {
    const diagnosticMessage = formatCdpSendDiagnostics(
      err,
      acquired.browserMode,
    );
    if (diagnosticMessage) {
      return { content: diagnosticMessage, isError: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, key }, "Press key failed");
    return { content: `Error: Press key failed: ${msg}`, isError: true };
  } finally {
    cdp.dispose();
  }
}

// ── browser_scroll ───────────────────────────────────────────────────

export async function executeBrowserScroll(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const direction = typeof input.direction === "string" ? input.direction : "";
  if (!direction || !["up", "down", "left", "right"].includes(direction)) {
    return {
      content:
        "Error: direction is required and must be one of: up, down, left, right.",
      isError: true,
    };
  }

  const amount =
    typeof input.amount === "number" ? Math.abs(input.amount) : 500;

  let deltaX = 0;
  let deltaY = 0;
  switch (direction) {
    case "up":
      deltaY = -amount;
      break;
    case "down":
      deltaY = amount;
      break;
    case "left":
      deltaX = -amount;
      break;
    case "right":
      deltaX = amount;
      break;
  }

  const acquired = acquireCdpClientWithMode(input, context);
  if (acquired.errorResult) return acquired.errorResult;
  const cdp = acquired.cdp;
  try {
    // Fetch viewport dimensions so we can dispatch the wheel event at
    // the viewport center — scrolling from (0, 0) misses sticky
    // headers and overflow containers on many sites.
    const { w, h } = await evaluateExpression<{ w: number; h: number }>(
      cdp,
      "({ w: window.innerWidth, h: window.innerHeight })",
      {},
      context.signal,
    );

    await dispatchWheelScroll(
      cdp,
      { x: w / 2, y: h / 2 },
      { deltaX, deltaY },
      context.signal,
    );

    return { content: `Scrolled ${direction} by ${amount}px`, isError: false };
  } catch (err) {
    const diagnosticMessage = formatCdpSendDiagnostics(
      err,
      acquired.browserMode,
    );
    if (diagnosticMessage) {
      return { content: diagnosticMessage, isError: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, direction }, "Scroll failed");
    return { content: `Error: Scroll failed: ${msg}`, isError: true };
  } finally {
    cdp.dispose();
  }
}

// ── browser_select_option ────────────────────────────────────────────

export async function executeBrowserSelectOption(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const { resolved, error } = resolveElement(context.conversationId, input);
  if (error) return { content: error, isError: true };

  const value = typeof input.value === "string" ? input.value : undefined;
  const label = typeof input.label === "string" ? input.label : undefined;
  const index = typeof input.index === "number" ? input.index : undefined;

  if (value === undefined && label === undefined && index === undefined) {
    return {
      content: "Error: One of value, label, or index is required.",
      isError: true,
    };
  }

  const targetDescription =
    resolved!.kind === "backend"
      ? `element_id "${resolved!.eid}"`
      : resolved!.selector;

  const acquired = acquireCdpClientWithMode(input, context);
  if (acquired.errorResult) return acquired.errorResult;
  const cdp = acquired.cdp;
  try {
    let backendNodeId: number;
    if (resolved!.kind === "backend") {
      backendNodeId = resolved!.backendNodeId;
    } else {
      backendNodeId = await querySelectorBackendNodeId(
        cdp,
        resolved!.selector,
        context.signal,
      );
    }

    // CDP does not expose a native "set select value" command, so we
    // resolve the node to a Runtime.RemoteObject and invoke a function
    // on it that applies value/label/index and dispatches `input`
    // followed by `change` (HTML spec order — Angular's
    // DefaultValueAccessor listens for `input`, so missing it breaks
    // form bindings on Angular sites).
    const { object } = await cdp.send<{ object: { objectId: string } }>(
      "DOM.resolveNode",
      { backendNodeId },
      context.signal,
    );
    const callResult = await cdp.send<{
      result?: { value?: boolean };
    }>(
      "Runtime.callFunctionOn",
      {
        objectId: object.objectId,
        functionDeclaration: `function(value, label, index) {
          let matched = false;
          if (value !== null && value !== undefined) {
            for (const opt of this.options) {
              if (opt.value === value) {
                this.value = value;
                matched = true;
                break;
              }
            }
          } else if (label !== null && label !== undefined) {
            for (const opt of this.options) {
              if (opt.label === label) {
                this.value = opt.value;
                matched = true;
                break;
              }
            }
          } else if (index !== null && index !== undefined) {
            if (index >= 0 && index < this.options.length) {
              this.selectedIndex = index;
              matched = true;
            }
          }
          if (matched) {
            this.dispatchEvent(new Event("input", { bubbles: true }));
            this.dispatchEvent(new Event("change", { bubbles: true }));
          }
          return matched;
        }`,
        arguments: [
          { value: value ?? null },
          { value: label ?? null },
          { value: index ?? null },
        ],
        returnByValue: true,
      },
      context.signal,
    );

    const matched = callResult?.result?.value === true;
    const desc =
      value !== undefined
        ? `value="${value}"`
        : label !== undefined
          ? `label="${label}"`
          : `index=${index}`;

    if (!matched) {
      return {
        content: `Error: Select option failed: no option matched ${desc} on ${targetDescription}.`,
        isError: true,
      };
    }

    return {
      content: `Selected option (${desc}) on element: ${targetDescription}`,
      isError: false,
    };
  } catch (err) {
    const diagnosticMessage = formatCdpSendDiagnostics(
      err,
      acquired.browserMode,
    );
    if (diagnosticMessage) {
      return { content: diagnosticMessage, isError: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, target: targetDescription }, "Select option failed");
    return { content: `Error: Select option failed: ${msg}`, isError: true };
  } finally {
    cdp.dispose();
  }
}

// ── browser_hover ────────────────────────────────────────────────────

export async function executeBrowserHover(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const { resolved, error } = resolveElement(context.conversationId, input);
  if (error) return { content: error, isError: true };

  const acquired = acquireCdpClientWithMode(input, context);
  if (acquired.errorResult) return acquired.errorResult;
  const cdp = acquired.cdp;
  try {
    let backendNodeId: number;
    if (resolved!.kind === "backend") {
      backendNodeId = resolved!.backendNodeId;
    } else {
      // Wait until the selector matches a visible element. See the
      // matching note in executeBrowserClick — async-hydrated pages
      // need this to behave like Playwright's hover-with-timeout.
      backendNodeId = await cdpWaitForSelector(
        cdp,
        resolved!.selector,
        ACTION_TIMEOUT_MS,
        context.signal,
      );
    }
    await scrollIntoViewIfNeeded(cdp, backendNodeId, context.signal);
    const point = await getCenterPoint(cdp, backendNodeId, context.signal);
    await dispatchHoverAt(cdp, point, context.signal);
    const desc =
      resolved!.kind === "backend"
        ? `eid=${resolved!.eid}`
        : resolved!.selector;
    return { content: `Hovered element: ${desc}`, isError: false };
  } catch (err) {
    const diagnosticMessage = formatCdpSendDiagnostics(
      err,
      acquired.browserMode,
    );
    if (diagnosticMessage) {
      return { content: diagnosticMessage, isError: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Hover failed");
    return { content: `Error: Hover failed: ${msg}`, isError: true };
  } finally {
    cdp.dispose();
  }
}

// ── browser_wait_for ─────────────────────────────────────────────────

export async function executeBrowserWaitFor(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  if (context.signal?.aborted) {
    return { content: "Error: operation was cancelled", isError: true };
  }

  const selector =
    typeof input.selector === "string" && input.selector
      ? input.selector
      : null;
  const text = typeof input.text === "string" && input.text ? input.text : null;
  const duration = typeof input.duration === "number" ? input.duration : null;

  const modeCount = [selector, text, duration].filter((v) => v != null).length;
  if (modeCount === 0) {
    return {
      content: "Error: Exactly one of selector, text, or duration is required.",
      isError: true,
    };
  }
  if (modeCount > 1) {
    return {
      content:
        "Error: Provide exactly one of selector, text, or duration (not multiple).",
      isError: true,
    };
  }

  const timeout =
    typeof input.timeout === "number"
      ? Math.min(input.timeout, MAX_WAIT_MS)
      : MAX_WAIT_MS;

  // Validate browser_mode even on the duration path so invalid values
  // are rejected consistently regardless of which wait mode is used.
  const modeResult = parseBrowserMode(input);
  if (!modeResult.ok) {
    return { content: modeResult.error, isError: true };
  }

  // Duration mode has no CDP interaction — handle without acquiring
  // a CdpClient so the common "sleep" path stays transport-agnostic.
  if (duration != null) {
    const waitMs = Math.min(duration, MAX_WAIT_MS);
    await new Promise((r) => setTimeout(r, waitMs));
    return { content: `Waited ${waitMs}ms.`, isError: false };
  }

  const acquired = acquireCdpClientWithMode(input, context);
  if (acquired.errorResult) return acquired.errorResult;
  const cdp = acquired.cdp;
  try {
    if (selector) {
      // browser_wait_for selector mode is "did this node appear at
      // all" — preserve the existing semantics by polling for DOM
      // attachment, not full visibility. Tools that need
      // visible-state polling (click/hover) get it via the default
      // state in cdpWaitForSelector.
      await cdpWaitForSelector(cdp, selector, timeout, context.signal, {
        state: "attached",
      });
      return {
        content: `Element matching "${selector}" appeared.`,
        isError: false,
      };
    }

    // text mode (validated above — modeCount === 1 means text is set)
    await cdpWaitForText(cdp, text!, timeout, context.signal);
    return {
      content: `Text "${truncate(text!, 80)}" appeared on page.`,
      isError: false,
    };
  } catch (err) {
    const diagnosticMessage = formatCdpSendDiagnostics(
      err,
      acquired.browserMode,
    );
    if (diagnosticMessage) {
      return { content: diagnosticMessage, isError: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Wait failed");
    return { content: `Error: Wait failed: ${msg}`, isError: true };
  } finally {
    cdp.dispose();
  }
}

// ── browser_extract ──────────────────────────────────────────────────

export async function executeBrowserExtract(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const includeLinks = input.include_links === true;

  const acquired = acquireCdpClientWithMode(input, context);
  if (acquired.errorResult) return acquired.errorResult;
  const cdp = acquired.cdp;
  try {
    const currentUrl = await getCurrentUrl(cdp, context.signal);
    const title = await getPageTitle(cdp, context.signal);

    let textContent = await evaluateExpression<string>(
      cdp,
      "document.body?.innerText ?? ''",
      {},
      context.signal,
    );

    if (textContent.length > MAX_EXTRACT_LENGTH) {
      textContent =
        safeStringSlice(textContent, 0, MAX_EXTRACT_LENGTH) +
        "\n... (truncated)";
    }

    const lines: string[] = [
      `URL: ${currentUrl}`,
      `Title: ${title || "(none)"}`,
      "",
      textContent || "(empty page)",
    ];

    if (includeLinks) {
      const links = await evaluateExpression<
        Array<{ text: string; href: string }>
      >(cdp, EXTRACT_LINKS_EXPRESSION, {}, context.signal);

      if (links.length > 0) {
        lines.push("");
        lines.push("Links:");
        for (const link of links) {
          lines.push(`  [${link.text || "(no text)"}](${link.href})`);
        }
      }
    }

    return { content: lines.join("\n"), isError: false };
  } catch (err) {
    const diagnosticMessage = formatCdpSendDiagnostics(
      err,
      acquired.browserMode,
    );
    if (diagnosticMessage) {
      return { content: diagnosticMessage, isError: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Extract failed");
    return { content: `Error: Extract failed: ${msg}`, isError: true };
  } finally {
    cdp.dispose();
  }
}

// ── browser credential fill ──────────────────────────────────────────

export async function executeBrowserFillCredential(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const service = typeof input.service === "string" ? input.service : "";
  const field = typeof input.field === "string" ? input.field : "";

  if (!service) {
    return { content: "Error: service is required.", isError: true };
  }
  if (!field) {
    return { content: "Error: field is required.", isError: true };
  }

  const { resolved, error } = resolveElement(context.conversationId, input);
  if (error) return { content: error, isError: true };

  const pressEnter = input.press_enter === true;
  const targetDescription =
    resolved!.kind === "backend"
      ? `element_id "${resolved!.eid}"`
      : resolved!.selector;

  const acquired = acquireCdpClientWithMode(input, context);
  if (acquired.errorResult) return acquired.errorResult;
  const cdp = acquired.cdp;
  try {
    let backendNodeId: number;
    if (resolved!.kind === "backend") {
      backendNodeId = resolved!.backendNodeId;
    } else {
      backendNodeId = await querySelectorBackendNodeId(
        cdp,
        resolved!.selector,
        context.signal,
      );
    }

    // Extract the current page's hostname for broker domain policy
    // enforcement. Failures here (pre-navigation, about:blank, malformed
    // URL) fall through with pageDomain undefined; if the credential
    // has a domain policy the broker will deny the fill.
    let pageDomain: string | undefined;
    try {
      const pageUrl = await getCurrentUrl(cdp, context.signal);
      if (pageUrl && pageUrl !== "about:blank") {
        const parsed = new URL(pageUrl);
        pageDomain = parsed.hostname;
      }
    } catch {
      // pageDomain stays undefined
    }

    const result = await credentialBroker.browserFill({
      service,
      field,
      toolName: BROWSER_FILL_CAPABILITY,
      domain: pageDomain,
      fill: async (value) => {
        // Clear-then-focus-then-insert via the shared helper. We
        // MUST clear first: Input.insertText writes at the cursor,
        // so on autofilled / pre-populated fields a bare insert
        // would append the credential to the existing value,
        // producing a corrupted password and leaking partial state
        // back into the page.
        await clearAndInsertText(cdp, backendNodeId, value, context.signal);
      },
    });

    if (!result.success) {
      const reason = result.reason ?? "unknown error";
      if (
        reason.includes("No credential found") ||
        reason.includes("no stored value")
      ) {
        return {
          content: `No credential stored for ${service}/${field}. Use credential_store to save it first.`,
          isError: true,
        };
      }
      if (reason.includes("not allowed to use credential")) {
        return {
          content: `Policy denied: ${reason} Update the credential's allowed_tools via credential_store if this tool should have access.`,
          isError: true,
        };
      }
      if (
        reason.includes("not allowed for credential") ||
        reason.includes("no page domain was provided")
      ) {
        return {
          content: `Domain policy denied: ${reason} Navigate to an allowed domain before filling this credential.`,
          isError: true,
        };
      }
      log.error(
        { target: targetDescription, reason },
        "Fill credential failed",
      );
      return {
        content: `Error: Fill credential failed: ${reason}`,
        isError: true,
      };
    }

    if (pressEnter) {
      await dispatchKeyPress(cdp, "Enter", context.signal);
    }

    return {
      content: `Filled ${field} for ${service} into the target element.`,
      isError: false,
    };
  } catch (err) {
    const diagnosticMessage = formatCdpSendDiagnostics(
      err,
      acquired.browserMode,
    );
    if (diagnosticMessage) {
      return { content: diagnosticMessage, isError: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Fill credential failed");
    return { content: `Error: Fill credential failed: ${msg}`, isError: true };
  } finally {
    cdp.dispose();
  }
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function modeTradeoffs(mode: StatusCheckMode): string[] {
  return MODE_TRADEOFFS[mode];
}

function extensionSetupActions(): string[] {
  return [
    "Install the Vellum Assistant Chrome extension from the Chrome Web Store: https://chromewebstore.google.com/detail/vellum-assistant-browser/hphbdmpffeigpcdjkckleobjmhhokpne",
    "Open the extension and pair with your assistant.",
  ];
}

function cdpInspectSetupActions(): string[] {
  return [
    "Update Chrome to the latest version by going to chrome://settings/help",
    "Navigate directly to chrome://inspect/#remote-debugging",
    'Check the box next to "Allow remote debugging for this browser instance"',
  ];
}

function localSetupActions(): string[] {
  return [
    "Ask your assistant to install playwright and chromium on your host machine.",
  ];
}

function extractDiscoveryCodes(error: CdpError): string[] {
  const diagnostics = error.attemptDiagnostics ?? [];
  const codes: string[] = [];
  for (const diag of diagnostics) {
    if (diag.discoveryCode) codes.push(diag.discoveryCode);
  }
  return dedupeStrings(codes);
}

function containsTokenCaseInsensitive(text: string, token: string): boolean {
  return text.toLowerCase().includes(token.toLowerCase());
}

function probeFailureActions(mode: StatusCheckMode, error: CdpError): string[] {
  const actions: string[] = [];
  const message = error.message.toLowerCase();
  const discoveryCodes = extractDiscoveryCodes(error).map((c) =>
    c.toLowerCase(),
  );

  if (mode === BROWSER_STATUS_MODE.EXTENSION) {
    actions.push(...extensionSetupActions());
    if (
      containsTokenCaseInsensitive(
        message,
        EXTENSION_STATUS_ERROR_MARKER.UNAUTHORIZED_ORIGIN,
      )
    ) {
      actions.push(
        "Ensure this extension ID is present in meta/browser-extension/chrome-extension-allowlist.json and restart the assistant.",
      );
    }
    if (
      containsTokenCaseInsensitive(
        message,
        EXTENSION_STATUS_ERROR_MARKER.NATIVE_MESSAGING_HOST,
      )
    ) {
      actions.push(
        "Reinstall the native messaging host manifest and confirm it allows this extension ID.",
      );
    }
    if (
      containsTokenCaseInsensitive(
        message,
        EXTENSION_STATUS_ERROR_MARKER.HTTP_401,
      )
    ) {
      actions.push(
        "Re-pair the extension so it refreshes its local relay credential.",
      );
    }
  }

  if (mode === BROWSER_STATUS_MODE.CDP_INSPECT) {
    actions.push(...cdpInspectSetupActions());
    if (discoveryCodes.includes(CDP_INSPECT_STATUS_DISCOVERY_CODE.NO_TARGETS)) {
      actions.push("Open at least one normal web page tab and retry.");
    }
    if (
      discoveryCodes.includes(
        CDP_INSPECT_STATUS_DISCOVERY_CODE.INVALID_RESPONSE,
      ) ||
      discoveryCodes.includes(
        CDP_INSPECT_STATUS_DISCOVERY_CODE.WS_FALLBACK_FAILED,
      )
    ) {
      actions.push(
        "Verify nothing else is bound to the configured CDP port and exposing non-DevTools responses.",
      );
    }
  }

  if (mode === BROWSER_STATUS_MODE.LOCAL) {
    actions.push(...localSetupActions());
  }

  return dedupeStrings(actions);
}

async function probePinnedBrowserMode(
  mode: StatusCheckMode,
  context: ToolContext,
): Promise<
  | {
      ok: true;
      backendKind: CdpClientKind;
    }
  | {
      ok: false;
      error: CdpError;
      diagnostic: string;
    }
> {
  let cdp: ReturnType<typeof getCdpClient> | null = null;
  try {
    cdp = getCdpClient(context, { mode });
    await cdp.send(
      "Runtime.evaluate",
      {
        expression: "document.readyState",
        returnByValue: true,
      },
      context.signal,
    );
    return { ok: true, backendKind: cdp.kind };
  } catch (err) {
    if (err instanceof CdpError) {
      return {
        ok: false,
        error: err,
        diagnostic: formatModeSelectionFailure(mode, err),
      };
    }
    const wrapped = new CdpError(
      "transport_error",
      err instanceof Error ? err.message : String(err),
      { underlying: err },
    );
    return {
      ok: false,
      error: wrapped,
      diagnostic: formatModeSelectionFailure(mode, wrapped),
    };
  } finally {
    cdp?.dispose();
  }
}

async function checkExtensionModeStatus(
  context: ToolContext,
  autoCandidate: boolean,
): Promise<BrowserStatusModeResult> {
  const proxyBound = Boolean(context.hostBrowserProxy);
  const proxyConnected = context.hostBrowserProxy?.isAvailable() ?? false;

  if (!proxyBound) {
    return {
      mode: BROWSER_STATUS_MODE.EXTENSION,
      available: false,
      verified: "preflight",
      autoCandidate,
      summary:
        "Extension mode is unavailable: no host browser proxy is bound to this conversation.",
      userActions: extensionSetupActions(),
      tradeoffs: modeTradeoffs(BROWSER_STATUS_MODE.EXTENSION),
      details: {
        proxyBound,
        proxyConnected,
      },
    };
  }

  if (!proxyConnected) {
    return {
      mode: BROWSER_STATUS_MODE.EXTENSION,
      available: false,
      verified: "preflight",
      autoCandidate,
      summary:
        "Extension mode is unavailable: the extension transport is currently disconnected.",
      userActions: extensionSetupActions(),
      tradeoffs: modeTradeoffs(BROWSER_STATUS_MODE.EXTENSION),
      details: {
        proxyBound,
        proxyConnected,
      },
    };
  }

  const probe = await probePinnedBrowserMode(
    BROWSER_STATUS_MODE.EXTENSION,
    context,
  );
  if (probe.ok) {
    return {
      mode: BROWSER_STATUS_MODE.EXTENSION,
      available: true,
      verified: "active_probe",
      autoCandidate,
      summary: "Extension mode is ready and responded to an active CDP probe.",
      userActions: [],
      tradeoffs: modeTradeoffs(BROWSER_STATUS_MODE.EXTENSION),
      details: {
        proxyBound,
        proxyConnected,
        backendKind: probe.backendKind,
      },
    };
  }

  if (isRestrictedChromePageProbeError(probe.error)) {
    return {
      mode: BROWSER_STATUS_MODE.EXTENSION,
      available: true,
      verified: "active_probe",
      autoCandidate,
      summary:
        "Extension mode transport is connected, but the active Chrome tab is a restricted chrome:// page. Switch to a regular website tab if browser actions fail.",
      userActions: [
        "Switch Chrome to a regular http(s) tab (not chrome://...) and retry.",
      ],
      tradeoffs: modeTradeoffs(BROWSER_STATUS_MODE.EXTENSION),
      details: {
        proxyBound,
        proxyConnected,
        restrictedActiveTab: true,
        errorCode: probe.error.code,
        diagnostic: probe.diagnostic,
        attemptDiagnostics: probe.error.attemptDiagnostics ?? [],
      },
    };
  }

  return {
    mode: BROWSER_STATUS_MODE.EXTENSION,
    available: false,
    verified: "active_probe",
    autoCandidate,
    summary: `Extension mode probe failed: ${probe.error.message}`,
    userActions: probeFailureActions(
      BROWSER_STATUS_MODE.EXTENSION,
      probe.error,
    ),
    tradeoffs: modeTradeoffs(BROWSER_STATUS_MODE.EXTENSION),
    details: {
      proxyBound,
      proxyConnected,
      errorCode: probe.error.code,
      diagnostic: probe.diagnostic,
      attemptDiagnostics: probe.error.attemptDiagnostics ?? [],
    },
  };
}

async function checkCdpInspectModeStatus(
  context: ToolContext,
  autoCandidate: boolean,
): Promise<BrowserStatusModeResult> {
  const cdpInspectConfig = getConfig().hostBrowser.cdpInspect;
  const desktopAutoEnabled =
    context.transportInterface === "macos" &&
    cdpInspectConfig.desktopAuto.enabled;
  const cooldownActive =
    desktopAutoEnabled &&
    isDesktopAutoCooldownActive(cdpInspectConfig.desktopAuto.cooldownMs);

  const probe = await probePinnedBrowserMode(
    BROWSER_STATUS_MODE.CDP_INSPECT,
    context,
  );
  if (probe.ok) {
    return {
      mode: BROWSER_STATUS_MODE.CDP_INSPECT,
      available: true,
      verified: "active_probe",
      autoCandidate,
      summary:
        "CDP inspect mode is ready and responded to an active CDP probe.",
      userActions: [],
      tradeoffs: modeTradeoffs(BROWSER_STATUS_MODE.CDP_INSPECT),
      details: {
        backendKind: probe.backendKind,
        configEnabled: cdpInspectConfig.enabled,
        configHost: cdpInspectConfig.host,
        configPort: cdpInspectConfig.port,
        desktopAutoEnabled,
        desktopAutoCooldownActive: cooldownActive,
      },
    };
  }

  return {
    mode: BROWSER_STATUS_MODE.CDP_INSPECT,
    available: false,
    verified: "active_probe",
    autoCandidate,
    summary: `CDP inspect probe failed: ${probe.error.message}`,
    userActions: probeFailureActions(
      BROWSER_STATUS_MODE.CDP_INSPECT,
      probe.error,
    ),
    tradeoffs: modeTradeoffs(BROWSER_STATUS_MODE.CDP_INSPECT),
    details: {
      errorCode: probe.error.code,
      discoveryCodes: extractDiscoveryCodes(probe.error),
      diagnostic: probe.diagnostic,
      attemptDiagnostics: probe.error.attemptDiagnostics ?? [],
      configEnabled: cdpInspectConfig.enabled,
      configHost: cdpInspectConfig.host,
      configPort: cdpInspectConfig.port,
      desktopAutoEnabled,
      desktopAutoCooldownActive: cooldownActive,
    },
  };
}

async function checkLocalModeStatus(
  context: ToolContext,
  autoCandidate: boolean,
  checkLocalLaunch: boolean,
): Promise<BrowserStatusModeResult> {
  const runtime = await checkBrowserRuntime();
  if (!runtime.playwrightAvailable || !runtime.chromiumInstalled) {
    return {
      mode: BROWSER_STATUS_MODE.LOCAL,
      available: false,
      verified: "preflight",
      autoCandidate,
      summary:
        runtime.error ??
        "Local mode preflight failed: Playwright Chromium runtime is not ready.",
      userActions: localSetupActions(),
      tradeoffs: modeTradeoffs(BROWSER_STATUS_MODE.LOCAL),
      details: {
        runtime,
        launchProbeRequested: checkLocalLaunch,
      },
    };
  }

  if (!checkLocalLaunch) {
    return {
      mode: BROWSER_STATUS_MODE.LOCAL,
      available: true,
      verified: "preflight",
      autoCandidate,
      summary:
        "Local mode preflight passed (Playwright + Chromium are present). Launch probe was skipped.",
      userActions: [],
      tradeoffs: modeTradeoffs(BROWSER_STATUS_MODE.LOCAL),
      details: {
        runtime,
        launchProbeRequested: checkLocalLaunch,
      },
    };
  }

  const probe = await probePinnedBrowserMode(
    BROWSER_STATUS_MODE.LOCAL,
    context,
  );
  if (probe.ok) {
    return {
      mode: BROWSER_STATUS_MODE.LOCAL,
      available: true,
      verified: "active_probe",
      autoCandidate,
      summary: "Local mode is ready and responded to an active CDP probe.",
      userActions: [],
      tradeoffs: modeTradeoffs(BROWSER_STATUS_MODE.LOCAL),
      details: {
        runtime,
        launchProbeRequested: checkLocalLaunch,
        backendKind: probe.backendKind,
      },
    };
  }

  return {
    mode: BROWSER_STATUS_MODE.LOCAL,
    available: false,
    verified: "active_probe",
    autoCandidate,
    summary: `Local mode probe failed: ${probe.error.message}`,
    userActions: probeFailureActions(BROWSER_STATUS_MODE.LOCAL, probe.error),
    tradeoffs: modeTradeoffs(BROWSER_STATUS_MODE.LOCAL),
    details: {
      runtime,
      launchProbeRequested: checkLocalLaunch,
      errorCode: probe.error.code,
      diagnostic: probe.diagnostic,
      attemptDiagnostics: probe.error.attemptDiagnostics ?? [],
    },
  };
}

// ── browser_status ────────────────────────────────────────────────────

export async function executeBrowserStatus(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const parsedMode = parseBrowserMode(input);
  if (!parsedMode.ok) {
    return { content: parsedMode.error, isError: true };
  }

  if (
    input[BROWSER_STATUS_INPUT_FIELD.CHECK_LOCAL_LAUNCH] !== undefined &&
    typeof input[BROWSER_STATUS_INPUT_FIELD.CHECK_LOCAL_LAUNCH] !== "boolean"
  ) {
    return {
      content: `Error: ${BROWSER_STATUS_INPUT_FIELD.CHECK_LOCAL_LAUNCH} must be a boolean when provided.`,
      isError: true,
    };
  }

  const checkLocalLaunch =
    input[BROWSER_STATUS_INPUT_FIELD.CHECK_LOCAL_LAUNCH] === true;
  const requestedMode = parsedMode.mode;
  const modesToCheck: readonly StatusCheckMode[] =
    requestedMode === BROWSER_MODE.AUTO
      ? BROWSER_STATUS_MODES
      : [requestedMode];

  const autoCandidateKinds = buildCandidateList(context).map((c) => c.kind);
  const autoCandidateSet = new Set<CdpClientKind>(autoCandidateKinds);

  try {
    const modeResults: BrowserStatusModeResult[] = [];
    for (const mode of modesToCheck) {
      const autoCandidate = autoCandidateSet.has(mode);
      if (mode === BROWSER_STATUS_MODE.EXTENSION) {
        modeResults.push(
          await checkExtensionModeStatus(context, autoCandidate),
        );
      } else if (mode === BROWSER_STATUS_MODE.CDP_INSPECT) {
        modeResults.push(
          await checkCdpInspectModeStatus(context, autoCandidate),
        );
      } else {
        modeResults.push(
          await checkLocalModeStatus(context, autoCandidate, checkLocalLaunch),
        );
      }
    }

    const stickyMode = browserManager.getPreferredBackendKind(
      context.conversationId,
    );
    const availableModes = modeResults
      .filter((r) => r.available)
      .map((r) => r.mode);
    const recommendedMode =
      autoCandidateKinds.find((candidate) =>
        modeResults.some(
          (result) => result.mode === candidate && result.available,
        ),
      ) ??
      availableModes[0] ??
      null;

    return {
      content: JSON.stringify(
        {
          requestedMode,
          checkedModes: modesToCheck,
          autoCandidateOrder: autoCandidateKinds,
          stickyConversationMode: stickyMode,
          recommendedMode,
          checkLocalLaunch,
          modes: modeResults,
        },
        null,
        2,
      ),
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: `Error: browser status check failed: ${msg}`,
      isError: true,
    };
  }
}
