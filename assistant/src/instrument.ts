import { arch, hostname, platform, release } from "node:os";

import * as Sentry from "@sentry/node";

import { getSentryDsn } from "./config/env.js";
import { APP_VERSION, COMMIT_SHA } from "./version.js";

/** Patterns that match sensitive data in Sentry event values. */
const PII_PATTERNS = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  /\b(?:\d{4}[- ]){3}\d{1,7}\b|\b\d{13,19}\b/g,
  /\b\d{3}-\d{2}-\d{4}\b/g,
];

function redactString(value: string): string {
  let result = value;
  for (const pattern of PII_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

function redactObject(obj: unknown): unknown {
  if (typeof obj === "string") return redactString(obj);
  if (Array.isArray(obj)) return obj.map(redactObject);
  if (obj != null && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      out[key] = redactObject(val);
    }
    return out;
  }
  return obj;
}

/**
 * Call after dotenv has loaded so SENTRY_DSN is available.
 * Always initializes Sentry to capture early startup crashes. If the user
 * later opts out via the "collect-usage-data" feature flag, call closeSentry()
 * after config is loaded to stop future event capturing.
 */
export function initSentry(): void {
  Sentry.init({
    dsn: getSentryDsn(),
    release: `vellum-assistant@${APP_VERSION}`,
    dist: COMMIT_SHA,
    environment: APP_VERSION === "0.0.0-dev" ? "development" : "production",
    sendDefaultPii: false,
    serverName: hostname(),
    initialScope: {
      tags: {
        commit: COMMIT_SHA,
        os_platform: platform(),
        os_release: release(),
        os_arch: arch(),
        server_name: hostname(),
        runtime: "bun",
        runtime_version:
          typeof Bun !== "undefined" ? Bun.version : process.version,
      },
    },
    beforeSend(event) {
      if (event.exception?.values) {
        event.exception.values = event.exception.values.map((ex) => ({
          ...ex,
          value: ex.value ? redactString(ex.value) : ex.value,
        }));
      }
      if (event.breadcrumbs) {
        event.breadcrumbs = event.breadcrumbs.map((bc) => ({
          ...bc,
          message: bc.message ? redactString(bc.message) : bc.message,
          data: bc.data
            ? (redactObject(bc.data) as Record<string, unknown>)
            : bc.data,
        }));
      }
      if (event.extra) {
        event.extra = redactObject(event.extra) as Record<string, unknown>;
      }
      return event;
    },
  });
}

/**
 * Stop capturing future Sentry events. Called after config loads when the
 * user has opted out of crash reporting so that early-startup crashes are
 * still captured but subsequent events are suppressed.
 */
export async function closeSentry(): Promise<void> {
  await Sentry.close();
}

// ── Dynamic session-scoped Sentry tags ──────────────────────────────
//
// These tags change per conversation turn and are set on the current
// Sentry scope before the agent loop runs. Any `Sentry.captureException`
// call within that async execution chain (e.g. inside agent/loop.ts)
// will inherit these tags, enabling filtering by conversation, session,
// user, or assistant in the Sentry dashboard.

/** Tag keys set by {@link setSentrySessionContext}. */
const SESSION_TAG_KEYS = [
  "assistant_id",
  "conversation_id",
  "session_id",
  "message_count",
  "user_identifier",
] as const;

export interface SentrySessionContext {
  /** Internal assistant ID (daemon uses 'self'). */
  assistantId: string;
  /** Conversation/session identifier. */
  conversationId: string;
  /** Number of messages in the conversation at time of the turn. */
  messageCount: number;
  /** Stable per-user identifier (guardian principal ID or similar). */
  userIdentifier?: string;
}

/**
 * Set session-scoped tags on the current Sentry scope.
 *
 * Call at the start of each agent loop turn so that any exceptions
 * captured within the turn include conversation/session context.
 */
export function setSentrySessionContext(ctx: SentrySessionContext): void {
  Sentry.setTag("assistant_id", ctx.assistantId);
  Sentry.setTag("conversation_id", ctx.conversationId);
  // session_id mirrors conversation_id — in this codebase they are the
  // same value, but downstream Sentry users may search by either name.
  Sentry.setTag("session_id", ctx.conversationId);
  Sentry.setTag("message_count", String(ctx.messageCount));
  if (ctx.userIdentifier) {
    Sentry.setTag("user_identifier", ctx.userIdentifier);
  }
}

/**
 * Clear session-scoped tags from the current Sentry scope.
 *
 * Call in the finally block after the agent loop completes so tags
 * from one conversation do not leak into unrelated error captures.
 */
export function clearSentrySessionContext(): void {
  for (const key of SESSION_TAG_KEYS) {
    Sentry.setTag(key, undefined);
  }
}
