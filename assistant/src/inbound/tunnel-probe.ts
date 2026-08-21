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
 *   - `GET /healthz` is the liveness verdict. Every ingress shape answers it:
 *     the nginx edge proxies it to the gateway, and a tunnel pointed straight
 *     at the gateway port serves it from the gateway itself. Anything but a
 *     2xx means the URL is not usable at all, which is `unreachable`.
 *   - `GET /assistant/__config` decides whether that live edge is one a device
 *     can pair against. Only the nginx remote-web SPA edge serves it
 *     (`buildRemoteWebIngressLocations` in `cli/src/lib/nginx-ingress.ts`),
 *     and that is the same edge serving `/assistant/pair`, so an edge that
 *     answers the config request with anything but that edge's own config is
 *     an edge whose pair URL would 404. That is `unpairable`: alive, and no
 *     use to a card whose whole job is pairing. A tunnel pointed straight at
 *     the gateway, a bring-your-own HTTPS front that only proxies the gateway,
 *     and a catch-all that answers every path with some JSON all land there.
 *     A config request that gets no answer at all, because it lost the shared
 *     deadline or the connection dropped under it, proves nothing either way,
 *     and the live `/healthz` stands.
 *
 * The served config also carries the assistant's id, which is what separates
 * `healthy` from `foreign`.
 *
 * Neither path is denylisted, so both are publicly reachable.
 *
 * The module takes a URL and an expected id and returns a verdict: it reads no
 * config and knows nothing about workspace paths, which is what lets callers
 * probe an arbitrary URL and lets tests run without network access.
 */

import {
  normalizeHttpPublicBaseUrlWithoutTrailingSlash,
  trimmedNonEmptyString,
} from "@vellumai/service-contracts/ingress";

import { isPlainObject } from "../util/object.js";
import { truncate } from "../util/truncate.js";

/**
 * Verdict for one probe.
 *
 * `unpairable` means the edge answered the config request with something that
 * is not the pairing edge's config, so it is alive without fronting the
 * pairing app.
 * `foreign` means the edge positively identified itself as a different
 * assistant. Any case where either id is unknown is `healthy`: a config
 * served by a CLI that predates the id, or a URL recorded before the id was
 * saved, is version skew, not someone else's assistant.
 */
export type TunnelProbeResult =
  | { kind: "healthy"; assistantId?: string; assistantName?: string }
  | { kind: "unreachable"; detail: string }
  | { kind: "unpairable"; detail?: string }
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

/** Reported when the config path answers with a body that is not a config. */
const UNREADABLE_CONFIG_DETAIL = "no assistant config served";

/** Reported when a served body parses but is not the pairing edge's config. */
const UNMARKED_CONFIG_DETAIL = "not a pairing edge config";

/**
 * Stamped into the served config by the nginx pairing edge and nothing else
 * (`remoteWebIngressConfig` in `cli/src/lib/nginx-ingress.ts`), which makes it
 * the marker that separates that edge from any other JSON a live URL serves.
 */
const PAIRING_EDGE_MODE = "remote-gateway";

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
  const base = normalizeHttpPublicBaseUrlWithoutTrailingSlash(
    args.publicBaseUrl,
  );
  if (base === undefined) {
    return { kind: "unreachable", detail: "not an http(s) URL" };
  }

  const fetchImpl = args.fetchImpl ?? globalThis.fetch.bind(globalThis);
  // One deadline covers both requests: only an answered config request can
  // demote a live edge, so a slow edge that answers `/healthz` and loses the
  // config request to the same deadline keeps its liveness verdict.
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

  const served = await readServedConfig(configResponse);
  if (served.kind === "notServed") {
    return { kind: "unpairable", detail: served.detail };
  }

  const identity = served.kind === "served" ? served.config : {};
  const expected = trimmedNonEmptyString(args.expectedAssistantId);
  const isForeign =
    expected !== undefined &&
    identity.assistantId !== undefined &&
    identity.assistantId !== expected;

  return { kind: isForeign ? "foreign" : "healthy", ...identity };
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

function isGenericFetchMessage(message: string): boolean {
  return GENERIC_FETCH_MESSAGES.has(message.toLowerCase());
}

/**
 * A dead tunnel surfaces as a generic wrapper ("fetch failed") whose `cause`
 * carries the reason worth reading (`ECONNREFUSED`, `ENOTFOUND`), so walk the
 * chain for a code, then for the first message that says something.
 */
function describeError(error: unknown): string {
  let message: string | undefined;
  let current: unknown = error;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!isPlainObject(current)) {
      break;
    }
    if (isTimeoutError(current)) {
      return "timeout";
    }
    const code = trimmedNonEmptyString(current.code);
    if (code !== undefined) {
      return code;
    }
    // A wrapper only holds the slot until a deeper level fills it.
    if (message === undefined || isGenericFetchMessage(message)) {
      message = trimmedNonEmptyString(current.message) ?? message;
    }
    current = current.cause;
  }

  return message ?? String(error);
}

interface ServedEdgeConfig {
  assistantId?: string;
  assistantName?: string;
}

/**
 * What the config request settled: the identity the pairing edge reports, a
 * positive "whatever is here does not serve the pairing app", or nothing.
 */
type ServedConfigReading =
  | { kind: "unanswered" }
  | { kind: "notServed"; detail: string }
  | { kind: "served"; config: ServedEdgeConfig };

/**
 * A 2xx JSON object carrying the pairing edge's marker is that edge
 * identifying itself, any other answer is an edge that does not serve the
 * pairing app, and no answer is no evidence.
 */
async function readServedConfig(
  response: Response | undefined,
): Promise<ServedConfigReading> {
  if (response === undefined) {
    return { kind: "unanswered" };
  }
  if (!response.ok) {
    await discardBody(response);
    return { kind: "notServed", detail: `HTTP ${response.status}` };
  }
  let detail = UNREADABLE_CONFIG_DETAIL;
  try {
    const body: unknown = await response.json();
    if (isPlainObject(body)) {
      if (body.mode === PAIRING_EDGE_MODE) {
        return {
          kind: "served",
          config: {
            assistantId: trimmedNonEmptyString(body.assistantId),
            assistantName: trimmedNonEmptyString(body.assistantName),
          },
        };
      }
      detail = UNMARKED_CONFIG_DETAIL;
    }
  } catch {
    /* an unparseable body is an edge answering with something else */
  }
  await discardBody(response);
  return { kind: "notServed", detail };
}
