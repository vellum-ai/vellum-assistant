/**
 * Route handler for forwarding client-side log messages to the assistant logger.
 *
 * POST /v1/client-log — accept a log entry from the native client (e.g. Swift
 * Coordinator forwarding WebView console messages) and write it to the
 * assistant's pino logger so it appears in the log export.
 */

import { z } from "zod";

import { getLogger } from "../../util/logger.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

const log = getLogger("client-log");

const VALID_LEVELS = new Set(["info", "warn", "error", "debug"]);

export async function handleClientLog(req: Request): Promise<Response> {
  let body: { level?: string; message?: string };
  try {
    body = (await req.json()) as { level?: string; message?: string };
  } catch {
    return httpError("BAD_REQUEST", "Invalid JSON body", 400);
  }

  const level = body.level ?? "info";
  const message = body.message;
  if (!message || typeof message !== "string") {
    return httpError("BAD_REQUEST", "message is required", 400);
  }
  const MAX_MESSAGE_LENGTH = 10_000;
  if (message.length > MAX_MESSAGE_LENGTH) {
    return httpError(
      "BAD_REQUEST",
      `message exceeds max length of ${MAX_MESSAGE_LENGTH} characters`,
      400,
    );
  }
  if (!VALID_LEVELS.has(level)) {
    return httpError(
      "BAD_REQUEST",
      `level must be one of: ${[...VALID_LEVELS].join(", ")}`,
      400,
    );
  }

  switch (level) {
    case "error":
      log.error(message);
      break;
    case "warn":
      log.warn(message);
      break;
    case "debug":
      log.debug(message);
      break;
    default:
      log.info(message);
      break;
  }

  return Response.json({ ok: true });
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function clientLogRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "client-log",
      method: "POST",
      summary: "Forward client log message",
      description:
        "Accept a log entry from the native client and write it to the assistant logger.",
      tags: ["telemetry"],
      requestBody: z.object({
        level: z
          .enum(["info", "warn", "error", "debug"])
          .optional()
          .describe("Log level (default: info)"),
        message: z.string().describe("Log message text"),
      }),
      responseBody: z.object({
        ok: z.literal(true),
      }),
      handler: async ({ req }) => handleClientLog(req),
    },
  ];
}
