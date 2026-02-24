import * as Sentry from "@sentry/node";
import { APP_VERSION } from "./version.js";
import { getSentryDsn } from "./config/env.js";

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
  if (obj !== null && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      out[key] = redactObject(val);
    }
    return out;
  }
  return obj;
}

/** Call after dotenv has loaded so SENTRY_DSN is available. */
export function initSentry(): void {
  Sentry.init({
    dsn: getSentryDsn(),
    release: `vellum-assistant@${APP_VERSION}`,
    environment: APP_VERSION === "0.0.0-dev" ? "development" : "production",
    sendDefaultPii: false,
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
          data: bc.data ? (redactObject(bc.data) as Record<string, unknown>) : bc.data,
        }));
      }
      if (event.extra) {
        event.extra = redactObject(event.extra) as Record<string, unknown>;
      }
      return event;
    },
  });
}
