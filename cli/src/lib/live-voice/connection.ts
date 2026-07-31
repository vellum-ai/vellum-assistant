import { velayHostForPlatformHost } from "@vellumai/service-contracts/ingress";

import {
  resolveTargetAssistant,
  type AssistantEntry,
} from "../assistant-config.js";
import {
  loadGuardianSessionAccessToken,
  resolveGuardianSessionAuth,
} from "../guardian-session-auth.js";
import { isLoopbackUrl, loopbackSafeFetch } from "../loopback-fetch.js";
import { getPlatformUrl, readPlatformToken } from "../platform-client.js";
import { normalizeRuntimeUrl } from "../runtime-url.js";
import { mintLiveVoiceToken } from "./platform-auth.js";

const PREFLIGHT_TIMEOUT_MS = 10_000;
const LIVE_VOICE_PATH = "/v1/live-voice";
const LIVE_VOICE_PREFLIGHT_PATH = "/v1/live-voice/preflight";

export type LiveVoiceConnectionErrorCode =
  | "assistant_id_required"
  | "invalid_url"
  | "remote_tls_required"
  | "unsupported_topology"
  | "guardian_auth_required"
  | "guardian_auth_failed"
  | "platform_login_required"
  | "platform_auth_failed"
  | "velay_host_unavailable"
  | "not_ready";

export class LiveVoiceConnectionError extends Error {
  readonly code: LiveVoiceConnectionErrorCode;

  constructor(code: LiveVoiceConnectionErrorCode, message: string) {
    super(message);
    this.name = "LiveVoiceConnectionError";
    this.code = code;
  }
}

export interface LiveVoiceMissingProvider {
  readonly kind: "stt" | "tts";
  readonly providerId: string;
  readonly reason: string;
}

export type LiveVoicePreflightResult =
  | { readonly status: "ready" }
  | {
      readonly status: "not-ready";
      readonly missing?: readonly LiveVoiceMissingProvider[];
      readonly userMessage?: string;
    }
  | { readonly status: "unavailable" };

export interface LiveVoiceWebSocketEndpoint {
  readonly url: string;
  readonly logSafeUrl: string;
  readonly headers?: Readonly<Record<string, string>>;
}

interface LiveVoiceResolvedConnectionBase {
  readonly assistantId: string;
  readonly webSocket: LiveVoiceWebSocketEndpoint;
}

export interface DirectLiveVoiceConnection extends LiveVoiceResolvedConnectionBase {
  readonly topology: "direct";
  readonly gatewayUrl: string;
  readonly preflight: LiveVoicePreflightResult;
}

export interface ManagedLiveVoiceConnection extends LiveVoiceResolvedConnectionBase {
  readonly topology: "vellum-managed";
  readonly platformUrl: string;
}

export type LiveVoiceResolvedConnection =
  | DirectLiveVoiceConnection
  | ManagedLiveVoiceConnection;

export interface ResolveLiveVoiceConnectionOptions {
  /** Assistant display name or ID. Uses the active assistant when omitted. */
  readonly target?: string;
  /** Direct gateway override. Requires an assistant ID or resolvable target. */
  readonly url?: string;
  /** Assistant ID paired with an explicit direct gateway URL. */
  readonly assistantId?: string;
  /** Ephemeral guardian token for a direct gateway. */
  readonly guardianToken?: string;
}

export type LiveVoiceFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

interface LiveVoiceConnectionDependencies {
  readonly resolveTargetAssistant: (target?: string) => AssistantEntry;
  readonly loadGuardianSessionAccessToken: (
    assistantId: string,
  ) => string | undefined;
  readonly resolveGuardianSessionAuth: typeof resolveGuardianSessionAuth;
  readonly readPlatformToken: () => string | null;
  readonly getPlatformUrl: () => string;
  readonly mintLiveVoiceToken: typeof mintLiveVoiceToken;
  readonly fetch: LiveVoiceFetch;
  readonly getVelayBaseUrl: () => string | undefined;
}

const defaultDependencies: LiveVoiceConnectionDependencies = {
  resolveTargetAssistant,
  loadGuardianSessionAccessToken,
  resolveGuardianSessionAuth,
  readPlatformToken,
  getPlatformUrl,
  mintLiveVoiceToken,
  fetch: loopbackSafeFetch,
  getVelayBaseUrl: () => process.env.VELAY_BASE_URL?.trim() || undefined,
};

export type LiveVoiceConnectionDependencyOverrides =
  Partial<LiveVoiceConnectionDependencies>;

function parseUrl(value: string): URL {
  try {
    const url = new URL(normalizeRuntimeUrl(value));
    if (url.username || url.password) {
      throw new Error("URL credentials are not supported");
    }
    return url;
  } catch {
    throw new LiveVoiceConnectionError(
      "invalid_url",
      "The live-voice endpoint URL is invalid.",
    );
  }
}

function isHttpOrWebSocketProtocol(protocol: string): boolean {
  return (
    protocol === "http:" ||
    protocol === "https:" ||
    protocol === "ws:" ||
    protocol === "wss:"
  );
}

function requireSecureRemote(url: URL): void {
  if (!isHttpOrWebSocketProtocol(url.protocol)) {
    throw new LiveVoiceConnectionError(
      "invalid_url",
      "The live-voice endpoint must use HTTP or WebSocket transport.",
    );
  }
  if (
    !isLoopbackUrl(url.toString()) &&
    url.protocol !== "https:" &&
    url.protocol !== "wss:"
  ) {
    throw new LiveVoiceConnectionError(
      "remote_tls_required",
      "Remote live-voice endpoints must use TLS.",
    );
  }
}

function gatewayHttpOrigin(value: string): URL {
  const url = parseUrl(value);
  requireSecureRemote(url);
  if (url.protocol === "ws:") {
    url.protocol = "http:";
  } else if (url.protocol === "wss:") {
    url.protocol = "https:";
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

export function buildDirectLiveVoiceWebSocketUrl(gatewayUrl: string): string {
  const url = gatewayHttpOrigin(gatewayUrl);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.pathname = LIVE_VOICE_PATH;
  return url.toString();
}

function validateMissingProviders(
  value: unknown,
): LiveVoiceMissingProvider[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const missing: LiveVoiceMissingProvider[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const candidate = item as Record<string, unknown>;
    if (
      (candidate.kind === "stt" || candidate.kind === "tts") &&
      typeof candidate.providerId === "string" &&
      typeof candidate.reason === "string"
    ) {
      missing.push({
        kind: candidate.kind,
        providerId: candidate.providerId,
        reason: candidate.reason,
      });
    }
  }
  return missing.length > 0 ? missing : undefined;
}

/**
 * Probe configured speech providers through a direct gateway. Only an
 * explicit not-ready verdict blocks voice. Network, HTTP, and version-skew
 * failures leave the WebSocket handshake authoritative.
 */
export async function preflightLiveVoice(
  gatewayUrl: string,
  accessToken?: string,
  fetchImpl: LiveVoiceFetch = loopbackSafeFetch,
): Promise<LiveVoicePreflightResult> {
  let url: URL;
  try {
    url = gatewayHttpOrigin(gatewayUrl);
  } catch {
    return { status: "unavailable" };
  }
  url.pathname = LIVE_VOICE_PREFLIGHT_PATH;

  try {
    const response = await fetchImpl(url.toString(), {
      method: "POST",
      headers: {
        Accept: "application/json",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { status: "unavailable" };
    }

    const body: unknown = await response.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return { status: "unavailable" };
    }
    const candidate = body as Record<string, unknown>;
    if (candidate.status === "ready") {
      return { status: "ready" };
    }
    if (candidate.status !== "not-ready") {
      return { status: "unavailable" };
    }

    const missing = validateMissingProviders(candidate.missing);
    return {
      status: "not-ready",
      ...(missing ? { missing } : {}),
      ...(typeof candidate.userMessage === "string"
        ? { userMessage: candidate.userMessage }
        : {}),
    };
  } catch {
    return { status: "unavailable" };
  }
}

function unsupportedTopologyMessage(cloud: string): string {
  if (cloud === "docker") {
    return "Live voice does not support Docker assistants yet. Run it against a host-local or Vellum-managed assistant.";
  }
  if (cloud === "paired") {
    return "Live voice does not support assistants paired from another machine yet. Run it on the assistant's host.";
  }
  return `Live voice does not support the '${cloud}' assistant topology yet.`;
}

function resolveExplicitDirectTarget(
  options: ResolveLiveVoiceConnectionOptions,
  deps: LiveVoiceConnectionDependencies,
): { assistantId: string; entry?: AssistantEntry } {
  if (options.assistantId) {
    return { assistantId: options.assistantId };
  }
  if (options.target) {
    const entry = deps.resolveTargetAssistant(options.target);
    return { assistantId: entry.assistantId, entry };
  }
  throw new LiveVoiceConnectionError(
    "assistant_id_required",
    "An explicit live-voice URL requires an assistant ID.",
  );
}

async function resolveDirectConnection(
  gatewayUrl: string,
  assistantId: string,
  entry: AssistantEntry | undefined,
  guardianToken: string | undefined,
  deps: LiveVoiceConnectionDependencies,
): Promise<DirectLiveVoiceConnection> {
  const httpOrigin = gatewayHttpOrigin(gatewayUrl);
  const loopback = isLoopbackUrl(httpOrigin.toString());
  const storedToken =
    guardianToken ??
    deps.loadGuardianSessionAccessToken(assistantId) ??
    entry?.bearerToken;
  const auth = await deps.resolveGuardianSessionAuth({
    runtimeUrl: httpOrigin.toString(),
    assistantId,
    accessToken: storedToken,
    cloud: "direct",
  });
  if (!auth.ok) {
    throw new LiveVoiceConnectionError(
      "guardian_auth_failed",
      "The guardian session could not authenticate live voice.",
    );
  }
  if (!loopback && !auth.accessToken) {
    throw new LiveVoiceConnectionError(
      "guardian_auth_required",
      "A remote direct gateway requires guardian authentication.",
    );
  }

  const preflight = await preflightLiveVoice(
    httpOrigin.toString(),
    auth.accessToken,
    deps.fetch,
  );
  if (preflight.status === "not-ready") {
    throw new LiveVoiceConnectionError(
      "not_ready",
      "Live voice is not ready. Configure speech-to-text and text-to-speech providers first.",
    );
  }

  const webSocketUrl = buildDirectLiveVoiceWebSocketUrl(httpOrigin.toString());
  return {
    topology: "direct",
    assistantId,
    gatewayUrl: httpOrigin.toString(),
    preflight,
    webSocket: {
      url: webSocketUrl,
      logSafeUrl: webSocketUrl,
      ...(auth.accessToken
        ? { headers: { Authorization: `Bearer ${auth.accessToken}` } }
        : {}),
    },
  };
}

function resolveExplicitVelayBaseUrl(value: string): {
  host: string;
  scheme: "ws" | "wss";
} {
  const url = parseUrl(value);
  requireSecureRemote(url);
  const scheme =
    url.protocol === "http:" || url.protocol === "ws:" ? "ws" : "wss";
  return { host: url.host, scheme };
}

function resolveVelayEndpoint(
  platformUrl: string,
  explicitVelayBaseUrl: string | undefined,
): { host: string; scheme: "ws" | "wss" } {
  const platform = parseUrl(platformUrl);
  requireSecureRemote(platform);

  if (explicitVelayBaseUrl) {
    return resolveExplicitVelayBaseUrl(explicitVelayBaseUrl);
  }

  const host = velayHostForPlatformHost(platform.hostname);
  if (!host) {
    throw new LiveVoiceConnectionError(
      "velay_host_unavailable",
      "The configured Vellum platform does not map to a live-voice ingress.",
    );
  }
  return { host, scheme: "wss" };
}

export function buildManagedLiveVoiceWebSocketUrl(options: {
  readonly assistantId: string;
  readonly token: string;
  readonly platformUrl: string;
  readonly velayBaseUrl?: string;
}): string {
  const endpoint = resolveVelayEndpoint(
    options.platformUrl,
    options.velayBaseUrl,
  );
  return buildManagedUrlFromEndpoint(
    options.assistantId,
    options.token,
    endpoint,
  );
}

function buildManagedUrlFromEndpoint(
  assistantId: string,
  token: string,
  endpoint: { host: string; scheme: "ws" | "wss" },
): string {
  const url = new URL(
    `${endpoint.scheme}://${endpoint.host}/${encodeURIComponent(assistantId)}${LIVE_VOICE_PATH}`,
  );
  url.searchParams.set("token", token);
  return url.toString();
}

function redactManagedUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.searchParams.has("token")) {
    parsed.searchParams.set("token", "[REDACTED]");
  }
  return parsed.toString();
}

async function resolveManagedConnection(
  entry: AssistantEntry,
  deps: LiveVoiceConnectionDependencies,
): Promise<ManagedLiveVoiceConnection> {
  const sessionToken = deps.readPlatformToken();
  if (!sessionToken) {
    throw new LiveVoiceConnectionError(
      "platform_login_required",
      "Live voice for a Vellum-managed assistant requires login. Run 'vellum login'.",
    );
  }

  const platformUrl = deps.getPlatformUrl();
  const velayBaseUrl = deps.getVelayBaseUrl();
  const velayEndpoint = resolveVelayEndpoint(platformUrl, velayBaseUrl);
  let minted: Awaited<ReturnType<typeof mintLiveVoiceToken>>;
  try {
    minted = await deps.mintLiveVoiceToken(
      sessionToken,
      entry.assistantId,
      platformUrl,
    );
  } catch {
    throw new LiveVoiceConnectionError(
      "platform_auth_failed",
      "The Vellum platform could not authenticate live voice. Run 'vellum login' to refresh.",
    );
  }
  const url = buildManagedUrlFromEndpoint(
    entry.assistantId,
    minted.token,
    velayEndpoint,
  );

  return {
    topology: "vellum-managed",
    assistantId: entry.assistantId,
    platformUrl,
    webSocket: {
      url,
      logSafeUrl: redactManagedUrl(url),
    },
  };
}

/**
 * Resolve the transport and credentials before audio capture begins. Provider
 * ownership is intentionally absent: a local assistant using managed speech
 * still routes through its directly reachable gateway.
 */
export async function resolveLiveVoiceConnection(
  options: ResolveLiveVoiceConnectionOptions = {},
  dependencyOverrides: LiveVoiceConnectionDependencyOverrides = {},
): Promise<LiveVoiceResolvedConnection> {
  const deps = { ...defaultDependencies, ...dependencyOverrides };

  if (options.url) {
    const target = resolveExplicitDirectTarget(options, deps);
    return resolveDirectConnection(
      options.url,
      target.assistantId,
      target.entry,
      options.guardianToken,
      deps,
    );
  }

  const entry = deps.resolveTargetAssistant(options.target);
  if (entry.cloud === "local") {
    return resolveDirectConnection(
      entry.localUrl || entry.runtimeUrl,
      entry.assistantId,
      entry,
      options.guardianToken,
      deps,
    );
  }
  if (entry.cloud === "vellum") {
    return resolveManagedConnection(entry, deps);
  }

  throw new LiveVoiceConnectionError(
    "unsupported_topology",
    unsupportedTopologyMessage(entry.cloud),
  );
}
