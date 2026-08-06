/**
 * Centralized platform API client.
 *
 * Owns managed proxy context resolution, prerequisite validation, and
 * authenticated fetch for all platform API calls.
 */

import { getPlatformAssistantId } from "../config/env.js";
import { resolveManagedProxyContext } from "../providers/platform-proxy/context.js";
import { credentialKey } from "../security/credential-key.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
import { getLogger } from "../util/logger.js";
import { arePlatformFeaturesEnabled } from "./feature-gate.js";

const log = getLogger("platform-client");

let _missingPrereqsWarned = false;

export interface OwnerConsent {
  /**
   * Telemetry is opt-out: the owner-consent endpoint returns effective
   * values (a never-chose null is served as consented), so an explicit
   * `false` is the only thing that disables sharing.
   */
  shareAnalytics: boolean;
  /** Same opt-out semantics as {@link shareAnalytics}. */
  shareDiagnostics: boolean;
  /**
   * Version of the diagnostics-sharing consent the owner accepted
   * ("YYYY-MM-DD", or "" if never accepted). Composes the per-turn
   * trace-collection gate: traces are only collected once this is >= the
   * disclosing version (see telemetry/trace-collection-policy.ts).
   */
  shareDiagnosticsAcceptedVersion: string;
}

interface PlatformClientConfig {
  baseUrl: string;
  apiKey: string;
  assistantId: string;
}

/**
 * Resolve the platform client's prerequisites.
 *
 * First tries the in-memory managed proxy context (available when the daemon
 * has rehydrated env overrides). Falls back to reading platform credentials
 * directly from the credential store so that standalone CLI invocations work
 * without the daemon having run its rehydration step.
 *
 * Returns `null` when auth prerequisites are missing (not logged in, no API
 * key). The assistant ID is resolved but not required.
 */
async function resolvePlatformClientConfig(): Promise<PlatformClientConfig | null> {
  if (!arePlatformFeaturesEnabled()) {
    log.debug("platform features disabled -- returning null");
    return null;
  }

  const ctx = await resolveManagedProxyContext();

  let baseUrl = ctx.enabled ? ctx.platformBaseUrl : "";
  let apiKey = ctx.enabled ? ctx.assistantApiKey : "";
  let assistantId = getPlatformAssistantId();

  // Fall back to credential store for values not yet rehydrated (standalone CLI).
  if (!baseUrl) {
    baseUrl =
      (await getSecureKeyAsync(credentialKey("vellum", "platform_base_url"))) ??
      "";
  }
  if (!apiKey) {
    apiKey =
      (await getSecureKeyAsync(credentialKey("vellum", "assistant_api_key"))) ??
      "";
  }
  if (!assistantId) {
    assistantId =
      (
        await getSecureKeyAsync(
          credentialKey("vellum", "platform_assistant_id"),
        )
      )?.trim() ?? "";
  }

  if (!baseUrl || !apiKey) {
    const level = _missingPrereqsWarned ? "debug" : "warn";
    _missingPrereqsWarned = true;
    log[level](
      {
        hasBaseUrl: !!baseUrl,
        hasApiKey: !!apiKey,
        hasAssistantId: !!assistantId,
        managedProxyEnabled: ctx.enabled,
      },
      "Platform client prerequisites missing -- returning null",
    );
    return null;
  }

  return { baseUrl, apiKey, assistantId };
}

// Bounds the configured probe: resolution can hit up to three credential-store
// reads, and urgent-notification dispatch awaits this probe, so a slow
// credential backend must answer from cache instead of stalling the banner.
const CONFIGURED_PROBE_DEADLINE_MS = 500;

let lastKnownConfigured: boolean | null = null;
// Single-flight slot with rotation: concurrent probes share one resolution,
// while a flight some caller already gave up on is replaced so a hung
// credential backend cannot pin the slot (and the cache) stale until a 45s
// credential timeout finally settles it. Generation fencing keeps an
// out-of-order settle from a rotated-out flight from overwriting the result a
// newer flight already wrote.
interface ConfiguredProbeFlight {
  promise: Promise<boolean>;
  generation: number;
  // Set once a caller's deadline elapsed on this flight. Rotation keys off
  // this observed give-up rather than a wall-clock age, so the decision never
  // lands on the deadline boundary, where drift between the timer's clock and
  // Date.now() would decide whether a caller rejoins the flight it just
  // abandoned.
  abandoned: boolean;
}
let inFlightConfiguredProbe: ConfiguredProbeFlight | null = null;
let probeGeneration = 0;
let lastWrittenGeneration = 0;

export function _resetConfiguredProbeCacheForTests(): void {
  lastKnownConfigured = null;
  inFlightConfiguredProbe = null;
  // Outstanding flights all carry generations at or below the current
  // counter; raising the written floor to it blocks their settles from
  // resurrecting the cache after a reset.
  lastWrittenGeneration = probeGeneration;
}

function startOrJoinConfiguredProbe(): ConfiguredProbeFlight {
  const existing = inFlightConfiguredProbe;
  if (existing !== null && !existing.abandoned) {
    return existing;
  }
  probeGeneration += 1;
  const generation = probeGeneration;
  const promise = resolvePlatformClientConfig()
    .then((config) => config !== null && config.assistantId.length > 0)
    .catch((err: unknown) => {
      log.debug(
        { err },
        "Configured probe failed -- treating as not configured",
      );
      return false;
    })
    .then((value) => {
      if (generation > lastWrittenGeneration) {
        lastKnownConfigured = value;
        lastWrittenGeneration = generation;
      }
      if (inFlightConfiguredProbe?.generation === generation) {
        inFlightConfiguredProbe = null;
      }
      return value;
    });
  const flight: ConfiguredProbeFlight = {
    promise,
    generation,
    abandoned: false,
  };
  inFlightConfiguredProbe = flight;
  return flight;
}

/**
 * Whether the platform client can actually dispatch: auth prerequisites plus
 * a nonempty platform assistant id (`PlatformPushAdapter.send()` fails fast
 * without one). Constructs no client and makes no network requests.
 *
 * Bounded by {@link CONFIGURED_PROBE_DEADLINE_MS}: when config resolution is
 * slower than the deadline, returns the last settled result (or `false` when
 * none exists yet) and marks the flight abandoned. Concurrent calls share one
 * in-flight resolution; the next call after an abandonment starts a fresh one,
 * so a hung backend never pins the cache stale, and generation fencing keeps a
 * rotated-out flight's late settle from overwriting a newer result.
 */
export async function isPlatformClientConfigured(): Promise<boolean> {
  const flight = startOrJoinConfiguredProbe();

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    deadlineTimer = setTimeout(
      () => resolve("deadline"),
      CONFIGURED_PROBE_DEADLINE_MS,
    );
  });
  const raced = await Promise.race([flight.promise, deadline]);
  clearTimeout(deadlineTimer);
  if (raced === "deadline") {
    flight.abandoned = true;
    return lastKnownConfigured ?? false;
  }
  return raced;
}

export class VellumPlatformClient {
  private readonly platformBaseUrl: string;
  private readonly apiKey: string;
  private readonly assistantId: string;

  private constructor(
    platformBaseUrl: string,
    apiKey: string,
    assistantId: string,
  ) {
    this.platformBaseUrl = platformBaseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.assistantId = assistantId;
  }

  /**
   * Create a platform client from {@link resolvePlatformClientConfig}.
   *
   * Returns `null` when auth prerequisites are missing (not logged in, no API
   * key). The assistant ID is resolved but not required -- callers that need
   * it should check `platformAssistantId` themselves.
   */
  static async create(): Promise<VellumPlatformClient | null> {
    const config = await resolvePlatformClientConfig();
    if (!config) {
      return null;
    }
    return new VellumPlatformClient(
      config.baseUrl,
      config.apiKey,
      config.assistantId,
    );
  }

  /**
   * Authenticated fetch against the platform API.
   *
   * Prepends `platformBaseUrl` to `path` and injects the `Api-Key` auth header.
   * Callers handle response parsing and domain-specific error mapping.
   */
  async fetch(path: string, init?: RequestInit): Promise<Response> {
    const url = `${this.platformBaseUrl}${path}`;
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Api-Key ${this.apiKey}`);

    return fetch(url, { ...init, headers });
  }

  /**
   * Fetch the platform owner's telemetry consent for this assistant.
   *
   * The endpoint returns effective consent values (a never-chose null is
   * served as consented); an explicit `false` is the only disable.
   *
   * Returns `null` whenever the consent is unknown — missing assistant id,
   * any non-2xx response, a malformed body, or a network error. Never throws.
   */
  async getOwnerConsent(): Promise<OwnerConsent | null> {
    if (!this.assistantId) {
      return null;
    }

    try {
      const res = await this.fetch(
        `/v1/assistants/${this.assistantId}/owner-consent/`,
      );
      if (!res.ok) {
        log.debug(
          { status: res.status },
          "owner-consent fetch returned non-2xx — treating as unknown",
        );
        return null;
      }

      const body = (await res.json()) as {
        share_analytics?: unknown;
        share_diagnostics?: unknown;
        share_diagnostics_accepted_version?: unknown;
      };
      if (
        (typeof body.share_analytics !== "boolean" &&
          body.share_analytics !== null) ||
        (typeof body.share_diagnostics !== "boolean" &&
          body.share_diagnostics !== null)
      ) {
        log.debug("owner-consent body malformed — treating as unknown");
        return null;
      }

      return {
        // Opt-out: anything but an explicit false enables sharing.
        shareAnalytics: body.share_analytics !== false,
        shareDiagnostics: body.share_diagnostics !== false,
        // Back-compat: an older platform that doesn't return this field yields
        // "" → fails the trace-collection version gate → fail-closed (no trace).
        shareDiagnosticsAcceptedVersion:
          typeof body.share_diagnostics_accepted_version === "string"
            ? body.share_diagnostics_accepted_version
            : "",
      };
    } catch (err) {
      log.debug({ err }, "owner-consent fetch failed — treating as unknown");
      return null;
    }
  }

  get baseUrl(): string {
    return this.platformBaseUrl;
  }

  get assistantApiKey(): string {
    return this.apiKey;
  }

  get platformAssistantId(): string {
    return this.assistantId;
  }
}
