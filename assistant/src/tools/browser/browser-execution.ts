import type { ImageContent } from "../../providers/types.js";
import { getLogger } from "../../util/logger.js";
import { truncate } from "../../util/truncate.js";
import { credentialBroker } from "../credentials/broker.js";
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
import type { PageResponse, RouteHandler } from "./browser-manager.js";
import { browserManager } from "./browser-manager.js";
import {
  ensureScreencast,
  getSender,
  stopAllScreencasts,
  stopBrowserScreencast,
} from "./browser-screencast.js";
import {
  formatAxSnapshot,
  transformAxTree,
} from "./cdp-client/accessibility-snapshot.js";
import { getCurrentUrl, getPageTitle } from "./cdp-client/cdp-dom-helpers.js";
import { getCdpClient } from "./cdp-client/factory.js";

const log = getLogger("headless-browser");

// ── Constants ────────────────────────────────────────────────────────

export const NAVIGATE_TIMEOUT_MS = 15_000;

export const ACTION_TIMEOUT_MS = 10_000;

export const MAX_SNAPSHOT_ELEMENTS = 150;

export const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[contenteditable="true"]',
].join(", ");

export type SnapshotElement = {
  eid: string;
  tag: string;
  attrs: Record<string, string>;
  text: string;
};

export const MAX_WAIT_MS = 30_000;

export const MAX_EXTRACT_LENGTH = 50_000;

// ── Shared element resolution ────────────────────────────────────────

export function resolveSelector(
  conversationId: string,
  input: Record<string, unknown>,
): { selector: string | null; error: string | null } {
  const elementId =
    typeof input.element_id === "string" ? input.element_id : null;
  const rawSelector =
    typeof input.selector === "string" ? input.selector : null;

  if (!elementId && !rawSelector) {
    return {
      selector: null,
      error: "Error: Either element_id or selector is required.",
    };
  }

  if (elementId) {
    const resolved = browserManager.resolveSnapshotSelector(
      conversationId,
      elementId,
    );
    if (!resolved) {
      return {
        selector: null,
        error: `Error: element_id "${elementId}" not found. Run browser_snapshot first to get current element IDs.`,
      };
    }
    return { selector: resolved, error: null };
  }

  return { selector: rawSelector!, error: null };
}

/**
 * Discriminated union returned by {@link resolveElement}. The
 * `"backend"` variant is produced when an `element_id` from the most
 * recent AX-tree snapshot is resolved to a CDP `backendNodeId`; the
 * `"selector"` variant is produced when the caller passed a raw CSS
 * `selector` that should be resolved via `DOM.querySelector` (or
 * equivalent) at send-time by the individual tool.
 *
 * Consumed by CDP-migrated interaction tools (click, hover, type, …)
 * that talk to CDP directly rather than going through Playwright's
 * selector engine. Legacy tools that still drive a Playwright `Page`
 * continue to call {@link resolveSelector} and receive a plain string
 * selector — the two helpers coexist during the Phase 3 migration.
 */
export type ResolvedElement =
  | { kind: "backend"; backendNodeId: number; eid: string }
  | { kind: "selector"; selector: string };

/**
 * Resolve an element reference (either `element_id` from a prior
 * snapshot or a raw `selector`) for CDP-native tools. Behaves like
 * {@link resolveSelector} in its input validation but returns a
 * {@link ResolvedElement} instead of a string so the caller can
 * branch on whether a backendNodeId was recovered from the snapshot
 * map. Returns `{ resolved: null, error: "Error: …" }` on invalid
 * input or when an `element_id` is provided but the snapshot map is
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
      error: `Error: element_id "${elementId}" not found. Run browser_snapshot first to get current element IDs.`,
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

  // Block private/local targets by default
  if (!allowPrivateNetwork && isPrivateOrLocalHost(parsedUrl.hostname)) {
    return {
      content: `Error: Refusing to navigate to local/private network target (${parsedUrl.hostname}). Set allow_private_network=true if you explicitly need it.`,
      isError: true,
    };
  }

  // DNS resolution check for non-literal hostnames
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

  let routeHandler: RouteHandler | null = null;
  let blockedUrl: string | null = null;

  // Start screencast if a sender is registered for this conversation
  const sender = getSender(context.conversationId);
  if (sender) {
    await ensureScreencast(context.conversationId);
  }

  try {
    const page = await browserManager.getOrCreateSessionPage(
      context.conversationId,
    );
    log.debug(
      { url: safeRequestedUrl, conversationId: context.conversationId },
      "Navigating",
    );

    // Install request interception to block redirects/sub-requests to private networks.
    // This prevents SSRF bypass via server-side redirects and DNS rebinding attacks,
    // since Playwright follows redirects internally and performs its own DNS resolution.
    // Only skip for connectOverCDP browsers where page.route() is unreliable.
    if (!allowPrivateNetwork && browserManager.supportsRouteInterception) {
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
      await page.route("**/*", routeHandler);
    }

    // Use domcontentloaded but with a shorter timeout - if it times out,
    // the page is likely still usable (heavy SPAs like DoorDash keep loading
    // scripts after DOMContentLoaded). Fall back gracefully instead of failing.
    let response: PageResponse | null = null;
    let navigationTimedOut = false;
    const urlBeforeNav = page.url();
    try {
      response = await page.goto(parsedUrl.href, {
        waitUntil: "domcontentloaded",
        timeout: NAVIGATE_TIMEOUT_MS,
      });
    } catch (navErr) {
      const navMsg = navErr instanceof Error ? navErr.message : String(navErr);
      if (navMsg.includes("Timeout") || navMsg.includes("timeout")) {
        // If the page URL never changed from before navigation, the page
        // never actually loaded - re-throw instead of reporting success.
        if (page.url() === urlBeforeNav && urlBeforeNav !== parsedUrl.href) {
          throw navErr;
        }
        navigationTimedOut = true;
        log.info(
          { url: safeRequestedUrl },
          "Navigation timed out waiting for domcontentloaded, continuing with partial load",
        );
      } else {
        throw navErr;
      }
    }

    // Remove the route handler now that navigation is complete
    if (routeHandler) {
      await page.unroute("**/*", routeHandler);
      routeHandler = null;
    }

    // Reposition the browser window after navigation so the user can watch.
    // positionWindowSidebar() is a no-op when browserCdpSession is unavailable.
    if (!browserManager.isInteractive(context.conversationId)) {
      await browserManager.positionWindowSidebar();
    }

    if (blockedUrl) {
      return {
        content: `Error: Navigation blocked. A request targeted a local/private network address (${blockedUrl}). Set allow_private_network=true if you explicitly need it.`,
        isError: true,
      };
    }

    // Navigation changed the page content, so clear stale snapshot mappings.
    // Without this, element IDs from a previous page could resolve and cause
    // confusing Playwright timeout errors instead of the actionable
    // "run browser_snapshot first" message.
    browserManager.clearSnapshotMap(context.conversationId);

    // Auto-dismiss common blocker modals (regulatory notices, cookie banners)
    // that aren't exposed in the accessibility tree. Runs silently - if no
    // modal is present the evaluate is a no-op.
    try {
      await page.evaluate(`(() => {
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
      })()`);
    } catch {
      // Page may have navigated during evaluate - safe to ignore
    }

    const finalUrl = page.url();
    const safeFinalUrl = sanitizeUrlForOutput(new URL(finalUrl));
    const title = await page.title();
    const status = response?.status() ?? null;

    const lines: string[] = [
      `Requested URL: ${safeRequestedUrl}`,
      `Final URL: ${safeFinalUrl}`,
      `Status: ${status ?? "unknown"}`,
      `Title: ${title || "(none)"}`,
    ];

    if (navigationTimedOut) {
      lines.push(
        `Note: Page is still loading (domcontentloaded timed out). The page should still be interactive - use browser_snapshot to check.`,
      );
    }

    if (finalUrl !== parsedUrl.href) {
      lines.push(`Note: Page redirected from the requested URL.`);
    }

    // Detect auth challenges (login pages, 2FA, OAuth consent) and CAPTCHA challenges
    try {
      const authChallenge = await detectAuthChallenge(page);
      const captchaChallenge = await detectCaptchaChallenge(page);
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
          const still = await detectCaptchaChallenge(page);
          if (!still) {
            log.info("CAPTCHA auto-resolved");
            // Re-check for auth challenge now that CAPTCHA is gone -
            // the page may have loaded a login form behind it.
            challenge = await detectAuthChallenge(page);
            break;
          }
        }
      }

      if (challenge) {
        if (challenge.type === "captcha") {
          // CAPTCHA persisted after auto-resolve wait - hand off to user
          if (sender) {
            const { startHandoff } = await import("./browser-handoff.js");
            await startHandoff(context.conversationId, {
              reason: "captcha",
              message:
                "Cloudflare verification detected. Please solve the CAPTCHA in the Chrome window. The browser will automatically detect when you're done and resume.",
              bringToFront: true,
            });
            const newUrl = page.url();
            const newTitle = await page.title();
            lines.push("");
            lines.push(
              `CAPTCHA solved by user. Current page: ${newTitle} (${newUrl})`,
            );

            // Re-check for auth challenges - the page behind the CAPTCHA may have a login form
            const postCaptchaAuth = await detectAuthChallenge(page);
            if (postCaptchaAuth) {
              lines.push("");
              lines.push(formatAuthChallenge(postCaptchaAuth));
              lines.push("");
              lines.push(
                "Handle this by using browser tools to interact with the login form:",
              );
              lines.push(
                "1. Use browser_snapshot to find the sign-in form elements",
              );
              lines.push(
                "2. Use browser_fill_credential to fill email/password from credential_store",
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
          // using browser tools + credential_store. Don't hand off.
          lines.push("");
          lines.push(formatAuthChallenge(challenge));
          lines.push("");
          lines.push(
            "Handle this by using browser tools to interact with the login form:",
          );
          lines.push(
            "1. Use browser_snapshot to find the sign-in form elements",
          );
          lines.push(
            "2. Use browser_fill_credential to fill email/password from credential_store",
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
    // Best-effort cleanup of route handler on error
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
    // page.goto() throws. Return the clear security message instead of the
    // raw Playwright error (which could leak credentials from the URL).
    if (blockedUrl) {
      return {
        content: `Error: Navigation blocked. A request targeted a local/private network address (${blockedUrl}). Set allow_private_network=true if you explicitly need it.`,
        isError: true,
      };
    }

    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, url: safeRequestedUrl }, "Navigation failed");
    return { content: `Error: Navigation failed: ${msg}`, isError: true };
  }
}

// ── browser_snapshot ─────────────────────────────────────────────────

export async function executeBrowserSnapshot(
  _input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const cdp = getCdpClient(context);
  try {
    const currentUrl = await getCurrentUrl(cdp, context.signal);
    const title = await getPageTitle(cdp, context.signal);

    // Pull the full accessibility tree via CDP and fold it into typed
    // interactive elements + an `eid → backendNodeId` map. This replaces
    // the legacy `document.querySelectorAll` + `data-vellum-eid` JS that
    // used to drive the snapshot, and lets downstream CDP-migrated tools
    // (click, hover, type, …) jump straight to DOM commands without
    // another round-trip through Playwright's selector engine.
    await cdp.send("Accessibility.enable", {}, context.signal);
    const rawTree = await cdp.send(
      "Accessibility.getFullAXTree",
      {},
      context.signal,
    );
    const { elements, selectorMap: backendNodeMap } = transformAxTree(rawTree, {
      maxElements: MAX_SNAPSHOT_ELEMENTS,
    });

    browserManager.storeSnapshotBackendNodeMap(
      context.conversationId,
      backendNodeMap,
    );

    // Bridge: tag every surfaced element with `data-vellum-eid` via
    // `DOM.pushNodesByBackendIdsToFrontend` + `DOM.setAttributeValue`
    // so the legacy string selector map keeps working for unmigrated
    // interaction tools (click/type/hover/etc.) during the Phase 3
    // migration window. This block is removed in PR 12 once every
    // interaction tool resolves eids against the backendNodeId map
    // directly. The cost is ~one CDP call per interactive element per
    // snapshot — measurable but bounded to the migration window.
    const stringSelectorMap = new Map<string, string>();
    if (backendNodeMap.size > 0) {
      const eidsInOrder = [...backendNodeMap.keys()];
      const backendNodeIds = eidsInOrder.map((eid) => backendNodeMap.get(eid)!);
      try {
        const { nodeIds } = await cdp.send<{ nodeIds: number[] }>(
          "DOM.pushNodesByBackendIdsToFrontend",
          { backendNodeIds },
          context.signal,
        );
        for (let i = 0; i < eidsInOrder.length; i += 1) {
          const eid = eidsInOrder[i]!;
          const nodeId = nodeIds?.[i];
          if (!nodeId) continue;
          try {
            await cdp.send(
              "DOM.setAttributeValue",
              {
                nodeId,
                name: "data-vellum-eid",
                value: eid,
              },
              context.signal,
            );
            stringSelectorMap.set(eid, `[data-vellum-eid="${eid}"]`);
          } catch (tagErr) {
            // Best-effort: a single element failing to be tagged should
            // not invalidate the whole snapshot. Log and move on so the
            // backendNodeId path for that element still works.
            log.debug(
              { err: tagErr, eid, nodeId },
              "Failed to tag element with data-vellum-eid during legacy bridge",
            );
          }
        }
      } catch (bridgeErr) {
        // If the bridge itself blows up (e.g. pushNodesByBackendIdsToFrontend
        // rejected), fall through with an empty legacy map. Unmigrated
        // interaction tools will surface their own "element_id not
        // found" error which points the agent at `browser_snapshot`.
        log.warn(
          { err: bridgeErr },
          "Legacy snapshot selector bridge failed; unmigrated interaction tools may regress",
        );
      }
    }
    browserManager.storeSnapshotMap(context.conversationId, stringSelectorMap);

    return {
      content: formatAxSnapshot(
        { elements, selectorMap: backendNodeMap },
        { url: currentUrl, title },
      ),
      isError: false,
    };
  } catch (err) {
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
  const fullPage = input.full_page === true;

  try {
    const page = await browserManager.getOrCreateSessionPage(
      context.conversationId,
    );
    const buffer = await page.screenshot({
      type: "jpeg",
      quality: 80,
      fullPage,
    });
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
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Screenshot failed");
    return { content: `Error: Screenshot failed: ${msg}`, isError: true };
  }
}

// ── browser_close ────────────────────────────────────────────────────

export async function executeBrowserClose(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  try {
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Close failed");
    return { content: `Error: Close failed: ${msg}`, isError: true };
  }
}

// ── browser_click ────────────────────────────────────────────────────

export async function executeBrowserClick(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const { selector, error } = resolveSelector(context.conversationId, input);
  if (error) return { content: error, isError: true };

  const timeout =
    typeof input.timeout === "number" ? input.timeout : ACTION_TIMEOUT_MS;

  try {
    const page = await browserManager.getOrCreateSessionPage(
      context.conversationId,
    );
    await page.click(selector!, { timeout });
    return { content: `Clicked element: ${selector}`, isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, selector }, "Click failed");
    return { content: `Error: Click failed: ${msg}`, isError: true };
  }
}

// ── browser_type ─────────────────────────────────────────────────────

export async function executeBrowserType(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const { selector, error } = resolveSelector(context.conversationId, input);
  if (error) return { content: error, isError: true };

  const text = typeof input.text === "string" ? input.text : "";
  if (!text) {
    return { content: "Error: text is required.", isError: true };
  }

  const clearFirst = input.clear_first !== false; // default true
  const pressEnter = input.press_enter === true;

  try {
    const page = await browserManager.getOrCreateSessionPage(
      context.conversationId,
    );

    const fillTimeout =
      typeof input.timeout === "number" ? input.timeout : ACTION_TIMEOUT_MS;

    if (clearFirst) {
      await page.fill(selector!, text, { timeout: fillTimeout });
    } else {
      // Read existing content before appending. Use .value for form inputs,
      // with fallback to .innerText for contenteditable elements (preserves
      // visual line breaks from <br> and block elements, unlike textContent).
      const currentValue = (await page.evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(
          selector!,
        )}); if (!el) return ''; if (typeof el.value === 'string') return el.value; return el.innerText ?? ''; })()`,
      )) as string;
      await page.fill(selector!, currentValue + text, { timeout: fillTimeout });
    }

    if (pressEnter) {
      await page.press(selector!, "Enter");
    }

    const lines = [`Typed into element: ${selector}`];
    if (clearFirst) lines.push("(cleared existing content first)");
    if (pressEnter) lines.push("(pressed Enter after typing)");
    return { content: lines.join("\n"), isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, selector }, "Type failed");
    return { content: `Error: Type failed: ${msg}`, isError: true };
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

  try {
    const page = await browserManager.getOrCreateSessionPage(
      context.conversationId,
    );

    // If element_id or selector is provided, press key on that element
    const elementId =
      typeof input.element_id === "string" ? input.element_id : null;
    const rawSelector =
      typeof input.selector === "string" ? input.selector : null;

    if (elementId || rawSelector) {
      const { selector, error } = resolveSelector(
        context.conversationId,
        input,
      );
      if (error) {
        return { content: error, isError: true };
      }
      await page.press(selector!, key);
      return {
        content: `Pressed "${key}" on element: ${selector}`,
        isError: false,
      };
    }

    // No target -> press key on the page (focused element)
    await page.keyboard.press(key);
    return { content: `Pressed "${key}"`, isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, key }, "Press key failed");
    return { content: `Error: Press key failed: ${msg}`, isError: true };
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

  try {
    const page = await browserManager.getOrCreateSessionPage(
      context.conversationId,
    );

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

    await page.mouse.wheel(deltaX, deltaY);

    return { content: `Scrolled ${direction} by ${amount}px`, isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, direction }, "Scroll failed");
    return { content: `Error: Scroll failed: ${msg}`, isError: true };
  }
}

// ── browser_select_option ────────────────────────────────────────────

export async function executeBrowserSelectOption(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const { selector, error } = resolveSelector(context.conversationId, input);
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

  try {
    const page = await browserManager.getOrCreateSessionPage(
      context.conversationId,
    );

    const option: Record<string, string | number> = {};
    if (value !== undefined) option.value = value;
    else if (label !== undefined) option.label = label;
    else if (index !== undefined) option.index = index;

    await page.selectOption(selector!, option);

    const desc =
      value !== undefined
        ? `value="${value}"`
        : label !== undefined
          ? `label="${label}"`
          : `index=${index}`;
    return {
      content: `Selected option (${desc}) on element: ${selector}`,
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, selector }, "Select option failed");
    return { content: `Error: Select option failed: ${msg}`, isError: true };
  }
}

// ── browser_hover ────────────────────────────────────────────────────

export async function executeBrowserHover(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const { selector, error } = resolveSelector(context.conversationId, input);
  if (error) return { content: error, isError: true };

  try {
    const page = await browserManager.getOrCreateSessionPage(
      context.conversationId,
    );
    await page.hover(selector!, { timeout: ACTION_TIMEOUT_MS });

    return { content: `Hovered element: ${selector}`, isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, selector }, "Hover failed");
    return { content: `Error: Hover failed: ${msg}`, isError: true };
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

  try {
    const page = await browserManager.getOrCreateSessionPage(
      context.conversationId,
    );

    if (selector) {
      await page.waitForSelector(selector, { timeout });
      return {
        content: `Element matching "${selector}" appeared.`,
        isError: false,
      };
    }

    if (text) {
      const escaped = JSON.stringify(text);
      await page.waitForFunction(
        `document.body?.innerText?.includes(${escaped})`,
        { timeout },
      );
      return {
        content: `Text "${truncate(text, 80)}" appeared on page.`,
        isError: false,
      };
    }

    // duration mode (milliseconds)
    const waitMs = Math.min(duration!, MAX_WAIT_MS);
    await new Promise((r) => setTimeout(r, waitMs));
    return { content: `Waited ${waitMs}ms.`, isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Wait failed");
    return { content: `Error: Wait failed: ${msg}`, isError: true };
  }
}

// ── browser_extract ──────────────────────────────────────────────────

export async function executeBrowserExtract(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const includeLinks = input.include_links === true;

  try {
    const page = await browserManager.getOrCreateSessionPage(
      context.conversationId,
    );
    const currentUrl = page.url();
    const title = await page.title();

    let textContent = (await page.evaluate(
      `document.body?.innerText ?? ''`,
    )) as string;

    if (textContent.length > MAX_EXTRACT_LENGTH) {
      textContent =
        textContent.slice(0, MAX_EXTRACT_LENGTH) + "\n... (truncated)";
    }

    const lines: string[] = [
      `URL: ${currentUrl}`,
      `Title: ${title || "(none)"}`,
      "",
      textContent || "(empty page)",
    ];

    if (includeLinks) {
      const links = (await page.evaluate(`
        (() => {
          const anchors = Array.from(document.querySelectorAll('a[href]'));
          return anchors.slice(0, 200).map(a => ({
            text: (a.textContent || '').trim().slice(0, 80),
            href: a.href,
          }));
        })()
      `)) as Array<{ text: string; href: string }>;

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
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Extract failed");
    return { content: `Error: Extract failed: ${msg}`, isError: true };
  }
}

// ── browser_fill_credential ──────────────────────────────────────────

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

  const { selector, error } = resolveSelector(context.conversationId, input);
  if (error) return { content: error, isError: true };

  const pressEnter = input.press_enter === true;

  try {
    const page = await browserManager.getOrCreateSessionPage(
      context.conversationId,
    );

    // Extract domain from the current page for domain policy enforcement
    let pageDomain: string | undefined;
    try {
      const pageUrl = page.url();
      if (pageUrl && pageUrl !== "about:blank") {
        const parsed = new URL(pageUrl);
        pageDomain = parsed.hostname;
      }
    } catch {
      // Invalid URL - pageDomain stays undefined, broker will deny if domain policy exists
    }

    const result = await credentialBroker.browserFill({
      service,
      field,
      toolName: "browser_fill_credential",
      domain: pageDomain,
      fill: async (value) => {
        await page.fill(selector!, value);
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
      log.error({ selector, reason }, "Fill credential failed");
      return {
        content: `Error: Fill credential failed: ${reason}`,
        isError: true,
      };
    }

    if (pressEnter) {
      await page.press(selector!, "Enter");
    }

    return {
      content: `Filled ${field} for ${service} into the target element.`,
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Fill credential failed");
    return { content: `Error: Fill credential failed: ${msg}`, isError: true };
  }
}
