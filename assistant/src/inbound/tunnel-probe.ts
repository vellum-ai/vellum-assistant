/**
 * Reachability probe for the public URL a tunnel exposes.
 *
 * A tunnel's public URL is recorded in the workspace config, but a recorded
 * URL says nothing about whether anything still answers on it: the tunnel
 * process can die, the nginx edge can stay up while the gateway behind it is
 * down, and a URL can end up fronting a different assistant entirely. The
 * probe resolves that by asking the edge two questions at once:
 *
 *   - `GET /healthz` is proxied through nginx to the gateway, so a 2xx proves
 *     the whole chain tunnel -> nginx -> gateway.
 *   - `GET /assistant/__config` is a static nginx response carrying the
 *     assistant's identity, so it proves which assistant the edge fronts.
 *
 * Both paths live in `cli/src/lib/nginx-ingress.ts` and neither is denylisted,
 * so both are publicly reachable.
 *
 * The module takes a URL and an expected id and returns a verdict: it reads no
 * config and knows nothing about workspace paths, which is what lets callers
 * probe an arbitrary URL and lets tests run without network access.
 */

import { normalizePublicBaseUrl } from "@vellumai/service-contracts/ingress";

import { isPlainObject } from "../util/object.js";

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

export async function probeTunnel(args: {
  publicBaseUrl: string;
  /** Id recorded when this URL was saved; omit to skip the identity check. */
  expectedAssistantId?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<TunnelProbeResult> {
  const base = normalizePublicBaseUrl(args.publicBaseUrl);
  if (!base) {
    return { kind: "unreachable", detail: "no public base URL" };
  }

  const fetchImpl = args.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const signal = AbortSignal.timeout(args.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const [health, config] = await Promise.allSettled([
    fetchImpl(`${base}/healthz`, { signal }),
    fetchImpl(`${base}/assistant/__config`, { signal }),
  ]);

  if (health.status === "rejected") {
    return unreachable(describeError(health.reason), base);
  }
  if (config.status === "rejected") {
    return unreachable(describeError(config.reason), base);
  }
  if (!health.value.ok) {
    return unreachable(`HTTP ${health.value.status}`, base);
  }
  if (!config.value.ok) {
    return unreachable(`HTTP ${config.value.status}`, base);
  }

  const served = await readServedConfig(config.value);
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
  return { kind: "unreachable", detail: detail.replaceAll(base, REDACTED_URL) };
}

function describeError(error: unknown): string {
  if (isPlainObject(error)) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return "timeout";
    }
    const text = nonEmptyString(error.message);
    if (text !== undefined) {
      return text;
    }
  }
  return String(error);
}

interface ServedEdgeConfig {
  assistantId?: string;
  assistantName?: string;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * An edge answering with a body this cannot read is still an edge that is
 * answering, so an unreadable config yields an unknown identity rather than a
 * failure.
 */
async function readServedConfig(response: Response): Promise<ServedEdgeConfig> {
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
    return {};
  }
}
