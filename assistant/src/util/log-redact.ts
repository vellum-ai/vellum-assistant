/**
 * Pino log serializers that scrub sensitive data (bearer tokens, API keys,
 * authorization headers) from logged values.  Applied to every pino instance
 * so secrets never reach log files even when errors bubble up opaque objects.
 *
 * API-key patterns are intentionally duplicated from security/secret-scanner.ts
 * rather than imported — the scanner carries entropy analysis, encoded-secret
 * detection, and other heavyweight logic that a hot-path serializer should not
 * pull in.
 */

// ---------------------------------------------------------------------------
// Sensitive-value patterns (subset of secret-scanner PATTERNS)
// ---------------------------------------------------------------------------

const BEARER_RE = /Bearer [A-Za-z0-9._\-]+/g;

const API_KEY_PATTERNS: RegExp[] = [
  // AWS
  /AKIA[0-9A-Z]{16}/g,
  // GitHub
  /gh[pousr]_[A-Za-z0-9_]{36,255}/g,
  /github_pat_[A-Za-z0-9_]{22,255}/g,
  // GitLab
  /glpat-[A-Za-z0-9\-_]{20,}/g,
  // Stripe
  /sk_live_[A-Za-z0-9]{24,}/g,
  /rk_live_[A-Za-z0-9]{24,}/g,
  // Slack
  /xoxb-[0-9]{10,}-[0-9]{10,}-[A-Za-z0-9]{24,}/g,
  /xoxp-[0-9]{10,}-[0-9]{10,}-[0-9]{10,}-[a-f0-9]{32}/g,
  // Anthropic
  /sk-ant-[A-Za-z0-9\-_]{80,}/g,
  // OpenAI
  /sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}/g,
  /sk-proj-[A-Za-z0-9\-_]{40,}/g,
  // Google
  /AIza[A-Za-z0-9\-_]{35}/g,
  /GOCSPX-[A-Za-z0-9\-_]{28}/g,
  // SendGrid
  /SG\.[A-Za-z0-9\-_]{22}\.[A-Za-z0-9\-_]{43}/g,
  // Telegram bot token
  /[0-9]{8,10}:[A-Za-z0-9_-]{35}/g,
  // npm
  /npm_[A-Za-z0-9]{36}/g,
];

// Header names whose values should always be fully redacted
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
]);

// ---------------------------------------------------------------------------
// String redaction
// ---------------------------------------------------------------------------

function redactString(value: string): string {
  let result = value;

  // Redact bearer tokens
  result = result.replace(BEARER_RE, 'Bearer [REDACTED]');

  // Redact API key patterns
  for (const pattern of API_KEY_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, '[REDACTED]');
  }

  return result;
}

// ---------------------------------------------------------------------------
// Deep value redaction — walks objects/arrays and scrubs strings in place
// ---------------------------------------------------------------------------

function redactValue(value: unknown, depth: number): unknown {
  if (depth > 8) return value;

  if (typeof value === 'string') {
    return redactString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const lowerKey = key.toLowerCase();
      // Fully redact sensitive header values
      if (SENSITIVE_HEADERS.has(lowerKey)) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = redactValue(val, depth + 1);
      }
    }
    return result;
  }

  return value;
}

// ---------------------------------------------------------------------------
// Error serialization — extracts non-enumerable Error fields and cause chain
// ---------------------------------------------------------------------------

function serializeError(err: unknown, depth: number): unknown {
  if (depth > 8 || err === null || err === undefined) return err;

  if (!(err instanceof Error)) {
    return err;
  }

  const serialized: Record<string, unknown> = {
    name: err.name,
    message: err.message,
  };

  // AssistantError and subclasses carry a structured ErrorCode
  if ('code' in err && typeof (err as { code: unknown }).code === 'string') {
    serialized.code = (err as { code: string }).code;
  }

  if (err.stack) {
    serialized.stack = err.stack;
  }

  // Walk the cause chain recursively
  if (err.cause !== undefined) {
    serialized.cause = serializeError(err.cause, depth + 1);
  }

  // Preserve any additional enumerable properties (e.g. provider, statusCode, toolName)
  for (const [key, val] of Object.entries(err)) {
    if (!(key in serialized)) {
      serialized[key] = val;
    }
  }

  return serialized;
}

// ---------------------------------------------------------------------------
// Pino serializers
// ---------------------------------------------------------------------------

/**
 * Pino serializer for the `err` binding — extracts non-enumerable Error fields
 * (name, message, stack), structured codes, and cause chains, then redacts
 * secrets from the result.
 */
function errSerializer(err: unknown): unknown {
  return redactValue(serializeError(err, 0), 0);
}

/**
 * Pino serializer for `req` (HTTP request objects) — redacts authorization
 * headers and sensitive values in the URL/body.
 */
function reqSerializer(req: unknown): unknown {
  return redactValue(req, 0);
}

/**
 * Pino serializer for `res` (HTTP response objects) — redacts sensitive
 * header values that may appear in response logs.
 */
function resSerializer(res: unknown): unknown {
  return redactValue(res, 0);
}

/**
 * Pino serializers config object.  Spread this into the pino options `serializers`
 * field on every logger instance.
 */
export const logSerializers: Record<string, (value: unknown) => unknown> = {
  err: errSerializer,
  req: reqSerializer,
  res: resSerializer,
};

// Exported for testing
export { redactString as _redactString, redactValue as _redactValue };
