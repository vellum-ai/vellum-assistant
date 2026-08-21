/**
 * Reachability probe for the public URL a tunnel exposes.
 *
 * A tunnel's public URL is recorded in the workspace config, but a recorded
 * URL says nothing about whether anything still answers on it: the tunnel
 * process can die, the nginx edge can stay up while the gateway behind it is
 * down, and a URL can end up fronting a different assistant entirely. The
 * probe asks the edge two questions at once, and the two answers carry very
 * different weight:
 *
 *   - `GET /healthz` is the liveness verdict, and the only one. Every ingress
 *     shape answers it: the nginx edge proxies it to the gateway, and a
 *     tunnel pointed straight at the gateway port serves it from the gateway
 *     itself. A 2xx proves the whole chain; anything else means the URL is
 *     not usable.
 *   - `GET /assistant/__config` establishes identity, nothing more. Only the
 *     nginx remote-web SPA edge serves it (`buildRemoteWebIngressLocations`
 *     in `cli/src/lib/nginx-ingress.ts`). A gateway-direct tunnel, a
 *     bring-your-own HTTPS front, or a hand-set `ingress.publicBaseUrl` will
 *     404 there while working perfectly, so a config that is missing,
 *     failing, or unreadable leaves the identity unknown and never fails the
 *     probe. An edge answering with a body this cannot read is still an edge
 *     that is answering.
 *
 * Neither path is denylisted, so both are publicly reachable.
 *
 * The module takes a URL and an expected id and returns a verdict: it reads no
 * config and knows nothing about workspace paths, which is what lets callers
 * probe an arbitrary URL and lets tests run without network access.
 */

import { normalizeHttpPublicBaseUrl } from "@vellumai/service-contracts/ingress";

import { isPlainObject } from "../util/object.js";
import { truncate } from "../util/truncate.js";

/**
 * Verdict for one probe.
 *
 * `foreign` means the edge positively identified itself as a different
 * assistant. Any case where either id is unknown is `healthy`: a config
 * served by a CLI that predates the id, or a URL recorded before the id was
 * saved, is version skew, not someone else's assistant.
 */
export type TunnelProbeResult =
  | { kind: "healthy"; assistantId?: string; assistantName?: string }
  | { kind: "unreachable"; detail: string }
  | { kind: "foreign"; assistantId?: string; assistantName?: string };

const DEFAULT_TIMEOUT_MS = 4_000;

/** Placeholder swapped in for the probed URL so `detail` stays URL-free. */
const REDACTED_URL = "<url>";

/** `detail` is rendered inline in a settings card, so it has to stay short. */
const MAX_DETAIL_LENGTH = 120;

/** Bound on the `cause` walk, so a self-referential chain cannot spin. */
const MAX_CAUSE_DEPTH = 5;

/** Wrappers fetch layers raise when the real reason sits one `cause` down. */
const GENERIC_FETCH_MESSAGES = new Set(["fetch failed", "failed to fetch"]);

export async function probeTunnel(args: {
  publicBaseUrl: string;
  /** Id recorded when this URL was saved; omit to skip the identity check. */
  expectedAssistantId?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<TunnelProbeResult> {
  if (args.publicBaseUrl.trim().length === 0) {
    return { kind: "unreachable", detail: "no public base URL" };
  }
  // The same validation the config writers apply, so a value they would have
  // rejected is named as malformed rather than handed to `fetch` and reported
  // through whatever string that layer happens to produce.
  const normalized = normalizeHttpPublicBaseUrl(args.publicBaseUrl);
  if (normalized === undefined) {
    return { kind: "unreachable", detail: "not an http(s) URL" };
  }
  const base = normalized.replace(/\/+$/, "");

  const fetchImpl = args.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const signal = AbortSignal.timeout(args.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const [health, config] = await Promise.allSettled([
    fetchImpl(`${base}/healthz`, { signal }),
    fetchImpl(`${base}/assistant/__config`, { signal }),
  ]);
  const configResponse =
    config.status === "fulfilled" ? config.value : undefined;

  if (health.status === "rejected") {
    await discardBody(configResponse);
    return unreachable(describeError(health.reason), base);
  }
  // Liveness is the status line; the health body is never read.
  await discardBody(health.value);
  if (!health.value.ok) {
    await discardBody(configResponse);
    return unreachable(`HTTP ${health.value.status}`, base);
  }
  // An edge that stopped answering mid-probe outranks the liveness the 2xx
  // established, so a timeout on either path is still unreachable.
  if (config.status === "rejected" && isTimeoutError(config.reason)) {
    return unreachable("timeout", base);
  }

  const served = await readServedConfig(configResponse);
  const expected = nonEmptyString(args.expectedAssistantId);
  const isForeign =
    expected !== undefined &&
    served.assistantId !== undefined &&
    served.assistantId !== expected;

  return { kind: isForeign ? "foreign" : "healthy", ...served };
}

/**
 * Fetch layers vary in how much of the request they echo into an error
 * message, and the caller already knows which URL it asked about.
 */
function unreachable(detail: string, base: string): TunnelProbeResult {
  return {
    kind: "unreachable",
    detail: truncate(detail.replaceAll(base, REDACTED_URL), MAX_DETAIL_LENGTH),
  };
}

/**
 * An unread fetch body pins its socket until GC under Bun and undici, and the
 * probe runs on every settings mount, resume, and manual refresh.
 */
async function discardBody(response: Response | undefined): Promise<void> {
  try {
    await response?.body?.cancel();
  } catch {
    /* best effort */
  }
}

function isTimeoutError(error: unknown): boolean {
  return (
    isPlainObject(error) &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

/**
 * A dead tunnel surfaces as a generic wrapper ("fetch failed") whose `cause`
 * carries the reason worth reading (`ECONNREFUSED`, `ENOTFOUND`), so walk the
 * chain for a code, then for the first message that says something.
 */
function describeError(error: unknown): string {
  let firstMessage: string | undefined;
  let specificMessage: string | undefined;
  let current: unknown = error;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!isPlainObject(current)) {
      break;
    }
    if (isTimeoutError(current)) {
      return "timeout";
    }
    const code = nonEmptyString(current.code);
    if (code !== undefined) {
      return code;
    }
    const message = nonEmptyString(current.message);
    if (message !== undefined) {
      firstMessage ??= message;
      if (
        specificMessage === undefined &&
        !GENERIC_FETCH_MESSAGES.has(message.toLowerCase())
      ) {
        specificMessage = message;
      }
    }
    current = current.cause;
  }

  return specificMessage ?? firstMessage ?? String(error);
}

interface ServedEdgeConfig {
  assistantId?: string;
  assistantName?: string;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Identity only: every failure here yields an unknown identity. */
async function readServedConfig(
  response: Response | undefined,
): Promise<ServedEdgeConfig> {
  if (response === undefined || !response.ok) {
    await discardBody(response);
    return {};
  }
  try {
    const body: unknown = await response.json();
    if (!isPlainObject(body)) {
      return {};
    }
    return {
      assistantId: nonEmptyString(body.assistantId),
      assistantName: nonEmptyString(body.assistantName),
    };
  } catch {
    await discardBody(response);
    return {};
  }
}
