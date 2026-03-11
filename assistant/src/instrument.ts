import * as Sentry from "@sentry/node";

import { arch, platform, release } from "node:os";

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
    initialScope: {
      tags: {
        commit: COMMIT_SHA,
        os_platform: platform(),
        os_release: release(),
        os_arch: arch(),
        runtime: "bun",
        runtime_version: typeof Bun !== "undefined" ? Bun.version : process.version,
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
