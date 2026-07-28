/**
 * Host-browser proxy SSE events (`host_browser_request` /
 * `host_browser_cancel`).
 *
 * Server → client instructions that proxy CDP (Chrome DevTools Protocol)
 * commands to a browser attached on the desktop host (or chrome extension).
 * The client executes the command and POSTs the result back to
 * `/v1/host-browser-result`. `host_browser_cancel` withdraws an in-flight
 * request.
 *
 * Canonical wire-contract source. Daemon code imports the types
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const HostBrowserRequestEventSchema = z.object({
  type: z.literal("host_browser_request"),
  requestId: z.string(),
  conversationId: z.string(),
  /** CDP method name, e.g. "Page.navigate", "Runtime.evaluate". */
  cdpMethod: z.string(),
  /** Opaque JSON params object forwarded verbatim to CDP. */
  cdpParams: z.record(z.string(), z.unknown()).optional(),
  /** Optional CDP target/session ID; omitted = "most-recently-active tab". */
  cdpSessionId: z.string().optional(),
  /** Client-side timeout hint; defaults to 30s in the proxy. */
  timeout_seconds: z.number().optional(),
});

export type HostBrowserRequestEvent = z.infer<
  typeof HostBrowserRequestEventSchema
>;

export const HostBrowserCancelEventSchema = z.object({
  type: z.literal("host_browser_cancel"),
  requestId: z.string(),
});

export type HostBrowserCancelEvent = z.infer<
  typeof HostBrowserCancelEventSchema
>;
