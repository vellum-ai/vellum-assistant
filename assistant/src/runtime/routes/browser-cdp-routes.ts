/**
 * Route handler for the `assistant browser chrome relay` CLI shim.
 *
 * Accepts a single CDP command from out-of-process callers (the CLI
 * subprocess spawned by skill scripts) and routes it to the user's
 * Chrome via the connected chrome-extension WebSocket. The legacy
 * relay CLI was deleted with PR #24329; this route is the runtime
 * surface that lets the in-tree Amazon and Influencer skills keep
 * shelling out to `assistant browser chrome relay <action>` until
 * they migrate onto the new CDP-based skill API.
 *
 * Round-trip:
 *   1. Caller POSTs `{ cdpMethod, cdpParams, cdpSessionId }`.
 *   2. We register a pending interaction with a `directBrowserResolve`
 *      callback (no Conversation attached) and push a host_browser_request
 *      frame onto the connected chrome-extension WebSocket.
 *   3. The chrome extension drives chrome.debugger and POSTs the result
 *      to /v1/host-browser-result.
 *   4. host-browser-routes invokes our directBrowserResolve callback,
 *      which resolves the awaiting promise here.
 *   5. We return `{ result | error }` to the caller.
 *
 * If no chrome extension is connected we fail fast with 503 — the legacy
 * Amazon/Influencer scripts treat that as a recoverable error and prompt
 * the user to load the extension.
 */
import { v4 as uuid } from "uuid";
import { z } from "zod";

import { findGuardianForChannel } from "../../contacts/contact-store.js";
import type { ServerMessage } from "../../daemon/message-protocol.js";
import { getLogger } from "../../util/logger.js";
import { getChromeExtensionRegistry } from "../chrome-extension-registry.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";
import * as pendingInteractions from "../pending-interactions.js";

const log = getLogger("browser-cdp-routes");

/** Default per-call timeout while waiting for the chrome-extension result POST. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Synthetic conversation id stamped on host_browser_request envelopes from the CLI shim. */
const CLI_FAKE_CONVERSATION_ID = "cli-browser-relay";

const RequestBody = z.object({
  cdpMethod: z.string().min(1),
  cdpParams: z.record(z.string(), z.unknown()).optional(),
  cdpSessionId: z.string().optional(),
  /** Optional client-side timeout hint, in milliseconds. */
  timeoutMs: z.number().int().positive().max(120_000).optional(),
});

const ResponseBody = z.object({
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});

/**
 * Resolve the local guardian principal id used as the chrome-extension
 * registry key. Mirrors the lookup performed by
 * /v1/browser-extension-pair so the registry get() / send() calls hit
 * the same key.
 */
function resolveLocalGuardianId(): string | null {
  try {
    const result = findGuardianForChannel("vellum");
    if (result?.contact.principalId) {
      return result.contact.principalId;
    }
  } catch (err) {
    log.warn({ err }, "Failed to look up local vellum guardian");
  }
  return null;
}

/**
 * POST /v1/browser-cdp — drive a single CDP command through the chrome-
 * extension proxy on behalf of an out-of-process CLI caller.
 *
 * Authenticated like other /v1/* routes (the route policy below requires
 * `settings.write`, which the CLI shim's daemon-delivery JWT carries via
 * the `gateway_service_v1` profile).
 */
export async function handleBrowserCdp(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return httpError("BAD_REQUEST", "invalid JSON body", 400);
  }

  const parsed = RequestBody.safeParse(body);
  if (!parsed.success) {
    return httpError(
      "BAD_REQUEST",
      `invalid request body: ${parsed.error.message}`,
      400,
    );
  }

  const { cdpMethod, cdpParams, cdpSessionId, timeoutMs } = parsed.data;

  const guardianId = resolveLocalGuardianId();
  if (!guardianId) {
    return Response.json(
      {
        error: {
          code: "EXTENSION_NOT_CONNECTED",
          message:
            "No local vellum guardian — load the chrome extension and pair it first",
        },
      },
      { status: 503 },
    );
  }

  const registry = getChromeExtensionRegistry();
  if (!registry.get(guardianId)) {
    return Response.json(
      {
        error: {
          code: "EXTENSION_NOT_CONNECTED",
          message:
            "No chrome extension connected for the local guardian — open Chrome, load the Vellum extension, and click Connect",
        },
      },
      { status: 503 },
    );
  }

  const requestId = uuid();
  const effectiveTimeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const result = await new Promise<{ content: string; isError: boolean }>(
    (resolve) => {
      const timer = setTimeout(() => {
        // Drain the pending interaction so a late-arriving POST from
        // the extension lands in 404 territory rather than resolving a
        // promise no one is awaiting.
        pendingInteractions.resolve(requestId);
        resolve({
          content: `Timed out waiting for chrome extension result after ${effectiveTimeoutMs}ms`,
          isError: true,
        });
      }, effectiveTimeoutMs);

      pendingInteractions.register(requestId, {
        conversation: null,
        conversationId: CLI_FAKE_CONVERSATION_ID,
        kind: "host_browser",
        directBrowserResolve: (response) => {
          clearTimeout(timer);
          resolve(response);
        },
      });

      const envelope: ServerMessage = {
        type: "host_browser_request",
        requestId,
        conversationId: CLI_FAKE_CONVERSATION_ID,
        cdpMethod,
        cdpParams,
        ...(cdpSessionId !== undefined ? { cdpSessionId } : {}),
        timeout_seconds: Math.ceil(effectiveTimeoutMs / 1000),
      } as ServerMessage;

      const ok = registry.send(guardianId, envelope);
      if (!ok) {
        clearTimeout(timer);
        pendingInteractions.resolve(requestId);
        resolve({
          content:
            "Failed to send host_browser_request to chrome extension (no active connection)",
          isError: true,
        });
      }
    },
  );

  if (result.isError) {
    return Response.json(
      {
        error: {
          code: "CDP_ERROR",
          message: result.content,
        },
      },
      { status: 502 },
    );
  }

  // The chrome extension serializes the CDP result via JSON.stringify(frame.result).
  // Parse it back here so the CLI shim sees a structured object instead of
  // a string-wrapped JSON blob.
  let parsedResult: unknown;
  try {
    parsedResult = JSON.parse(result.content);
  } catch {
    parsedResult = result.content;
  }

  return Response.json({ result: parsedResult });
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function browserCdpRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "browser-cdp",
      method: "POST",
      summary: "Drive a single CDP command via the chrome extension",
      description:
        "Routes a Chrome DevTools Protocol command through the connected chrome extension. Used by the `assistant browser chrome relay` CLI shim that the in-tree Amazon and Influencer skills shell out to.",
      tags: ["browser"],
      requestBody: RequestBody,
      responseBody: ResponseBody,
      handler: async ({ req }) => handleBrowserCdp(req),
    },
  ];
}
