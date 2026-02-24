/**
 * Pino log serializers that scrub sensitive data (bearer tokens, API keys,
 * authorization headers) from logged values.
 *
 * This is a standalone copy for the gateway package — kept in sync with
 * assistant/src/util/log-redact.ts.  The gateway has no dependency on the
 * assistant package, so we duplicate the lightweight serializer rather than
 * adding a cross-package import.
 */

// ---------------------------------------------------------------------------
// Sensitive-value patterns
// ---------------------------------------------------------------------------

const BEARER_RE = /Bearer [A-Za-z0-9._\-]+/g;

const API_KEY_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/g,
  /gh[pousr]_[A-Za-z0-9_]{36,255}/g,
  /github_pat_[A-Za-z0-9_]{22,255}/g,
  /glpat-[A-Za-z0-9\-_]{20,}/g,
  /sk_live_[A-Za-z0-9]{24,}/g,
  /rk_live_[A-Za-z0-9]{24,}/g,
  /xoxb-[0-9]{10,}-[0-9]{10,}-[A-Za-z0-9]{24,}/g,
  /xoxp-[0-9]{10,}-[0-9]{10,}-[0-9]{10,}-[a-f0-9]{32}/g,
  /sk-ant-[A-Za-z0-9\-_]{80,}/g,
  /sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}/g,
  /sk-proj-[A-Za-z0-9\-_]{40,}/g,
  /AIza[A-Za-z0-9\-_]{35}/g,
  /GOCSPX-[A-Za-z0-9\-_]{28}/g,
  /SG\.[A-Za-z0-9\-_]{22}\.[A-Za-z0-9\-_]{43}/g,
  /[0-9]{8,10}:[A-Za-z0-9_-]{35}/g,
  /npm_[A-Za-z0-9]{36}/g,
];

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
]);

// ---------------------------------------------------------------------------
// String redaction
// ---------------------------------------------------------------------------

function redactString(value: string): string {
  let result = value;
  result = result.replace(BEARER_RE, "Bearer [REDACTED]");
  for (const pattern of API_KEY_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Deep value redaction
// ---------------------------------------------------------------------------

function redactValue(value: unknown, depth: number): unknown {
  if (depth > 8) return value;

  if (typeof value === "string") {
    return redactString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_HEADERS.has(key.toLowerCase())) {
        result[key] = "[REDACTED]";
      } else {
        result[key] = redactValue(val, depth + 1);
      }
    }
    return result;
  }

  return value;
}

// ---------------------------------------------------------------------------
// Pino serializers
// ---------------------------------------------------------------------------

export const logSerializers: Record<string, (value: unknown) => unknown> = {
  err: (err) => redactValue(err, 0),
  req: (req) => redactValue(req, 0),
  res: (res) => redactValue(res, 0),
};
