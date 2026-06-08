import { hostname } from "node:os";

import { getLocalLanIPv4 } from "./local";
import type { AssistantEntry } from "./assistant-config.js";

/**
 * Resolve the URL for a runtime migration endpoint, taking the assistant's
 * topology into account.
 *
 * - For local/docker assistants, `runtimeUrl` is the loopback gateway and
 *   the runtime serves `/v1/migrations/<subpath>` directly. The CLI hits
 *   that path with guardian-token bearer auth.
 * - For platform-managed (cloud="vellum") assistants, `runtimeUrl` is the
 *   platform host (e.g. `https://platform.vellum.ai`). The platform's
 *   `MigrationViewSet` does NOT expose `export-to-gcs` or arbitrary runtime
 *   migration paths under `/v1/migrations/...`. The wildcard runtime proxy
 *   at `/v1/assistants/<id>/<path:rest>` is what forwards arbitrary runtime
 *   paths to the managed runtime — vembda's unified proxy bootstraps the
 *   guardian token internally for the runtime call. From the CLI side it's
 *   user-session auth.
 *
 * The `subpath` is appended to the migrations namespace verbatim
 * (e.g. `"export-to-gcs"`, `"import-from-gcs"`, `\`jobs/${jobId}\``).
 */
export function resolveRuntimeMigrationUrl(
  entry: Pick<AssistantEntry, "cloud" | "runtimeUrl" | "assistantId">,
  subpath: string,
): string {
  if (entry.cloud === "vellum") {
    return `${entry.runtimeUrl}/v1/assistants/${entry.assistantId}/migrations/${subpath}`;
  }
  return `${entry.runtimeUrl}/v1/migrations/${subpath}`;
}

/**
 * Resolve the URL for a generic runtime endpoint under `/v1/<subpath>`,
 * taking the assistant's topology into account.
 *
 * - For local/docker assistants, `runtimeUrl` is the loopback gateway and
 *   the runtime serves `/v1/<subpath>` directly.
 * - For platform-managed (cloud="vellum") assistants the path is rewritten
 *   to the wildcard runtime proxy:
 *   `{platformUrl}/v1/assistants/<assistantId>/<subpath>`.
 *
 * The `subpath` is appended verbatim (e.g. `"identity"`).
 */
export function resolveRuntimeUrl(
  entry: Pick<AssistantEntry, "cloud" | "runtimeUrl" | "assistantId">,
  subpath: string,
): string {
  if (entry.cloud === "vellum") {
    return `${entry.runtimeUrl}/v1/assistants/${entry.assistantId}/${subpath}`;
  }
  return `${entry.runtimeUrl}/v1/${subpath}`;
}

/**
 * If the hostname in `url` matches this machine's local DNS name, LAN IP, or
 * raw hostname, replace it with 127.0.0.1 so the client avoids mDNS round-trips
 * when talking to an assistant running on the same machine. Trailing slashes are
 * stripped on a swap. Returns the input unchanged if it doesn't parse as a URL.
 */
function maybeSwapToLocalhost(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  const urlHost = parsed.hostname.toLowerCase();

  const localNames: string[] = [];

  const host = hostname();
  if (host) {
    localNames.push(host.toLowerCase());
    // Also consider the bare name without .local suffix
    if (host.toLowerCase().endsWith(".local")) {
      localNames.push(host.toLowerCase().slice(0, -".local".length));
    }
  }

  const lanIp = getLocalLanIPv4();
  if (lanIp) {
    localNames.push(lanIp);
  }

  if (localNames.includes(urlHost)) {
    parsed.hostname = "127.0.0.1";
    return parsed.toString().replace(/\/+$/, "");
  }

  return url;
}

/**
 * Canonical form of a runtime/base URL used throughout the CLI: trailing
 * slashes stripped, then localhost-swapped. This is exactly the transform
 * `vellum client` applies to the runtime URL it hands the TUI, so comparing two
 * URLs after passing both through this function is a like-for-like comparison.
 */
export function normalizeRuntimeUrl(url: string): string {
  return maybeSwapToLocalhost(url.replace(/\/+$/, ""));
}

/**
 * SECURITY: decide whether a guardian-token refresh may be sent to
 * `candidateUrl`, and to which URL it should actually go.
 *
 * `vellum client` lets `--url`/`-u` override the runtime URL while still reusing
 * the selected entry's stored guardian token, so a victim pointed at an
 * attacker-controlled (or poisoned/redirected) URL must NOT cause us to POST the
 * long-lived refreshToken + deviceId there. Refresh is permitted only when
 * `candidateUrl` normalizes to one of the entry's persisted URLs (`localUrl`,
 * which the CLI prefers when present, or `runtimeUrl`).
 *
 * Returns the persisted URL that the candidate matched — never the
 * caller-supplied `candidateUrl` verbatim — so credentials only ever reach a
 * trusted origin even if a caller forgets to use this return value. The matched
 * URL is preferred over always returning `runtimeUrl` so the refresh stays on
 * the same interface the session is using: e.g. a local entry may persist both a
 * loopback `localUrl` (which `vellum client` defaults to) and an externally
 * discovered `runtimeUrl`, and refreshing the loopback session against the
 * external address could be unreachable or needlessly cross the public
 * interface. Returns `null` when the candidate is untrusted (caller must skip
 * the refresh).
 */
export function trustedRefreshUrl(
  entry: Pick<AssistantEntry, "runtimeUrl" | "localUrl">,
  candidateUrl: string,
): string | null {
  const candidate = normalizeRuntimeUrl(candidateUrl);
  // localUrl first: it's what the CLI prefers when present, so the candidate is
  // most likely to match it, and we want to keep the refresh on that interface.
  for (const persisted of [entry.localUrl, entry.runtimeUrl]) {
    if (persisted && normalizeRuntimeUrl(persisted) === candidate) {
      return persisted;
    }
  }
  return null;
}
