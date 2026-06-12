import { getPlatformUrl } from "./platform-client.js";
import { DOCKERHUB_IMAGES } from "./docker.js";
import type { ServiceName } from "./docker.js";
import { loopbackSafeFetch } from "./loopback-fetch.js";
import { stripVersionPrefix } from "./version-compat.js";

export interface ResolvedImageRefs {
  imageTags: Record<ServiceName, string>;
  source: "platform" | "dockerhub";
}

export interface ReleaseListItem {
  version: string;
  is_stable?: boolean;
  assistant_image_ref?: string | null;
  gateway_image_ref?: string | null;
  credential_executor_image_ref?: string | null;
}

/**
 * The endpoint defaults `limit` to 10, which is too few to validate an
 * explicit --version against ("absent from the list" is treated as a hard
 * error) — always request the documented maximum.
 */
const RELEASES_FETCH_LIMIT = 100;

/**
 * Fetch the releases list from the platform API, optionally filtered by
 * channel (the `channel` param takes precedence over `stable` server-side).
 * `platformUrl` overrides the lockfile/env-resolved default — pass the
 * target assistant's platform URL when it may differ from the active one.
 * Returns `null` when the platform is unreachable or responds non-OK —
 * distinct from `[]` (platform answered, no releases).
 */
export async function fetchReleases(opts?: {
  channel?: "stable" | "preview";
  platformUrl?: string;
}): Promise<ReleaseListItem[] | null> {
  try {
    const platformUrl = opts?.platformUrl || getPlatformUrl();
    const filter = opts?.channel ? `channel=${opts.channel}` : "stable=true";
    const response = await loopbackSafeFetch(
      `${platformUrl}/v1/releases/?${filter}&limit=${RELEASES_FETCH_LIMIT}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) return null;
    return (await response.json()) as ReleaseListItem[];
  } catch {
    return null;
  }
}

/**
 * Fetch the latest stable release version from the platform API.
 * Returns the version string (e.g. "0.7.0") or null if unavailable.
 * The releases endpoint returns entries ordered newest-first.
 */
export async function fetchLatestStableVersion(): Promise<string | null> {
  const releases = await fetchReleases();
  return releases?.[0]?.version ?? null;
}

export type ImageRefResolution =
  | { status: "platform"; imageTags: Record<ServiceName, string> }
  | { status: "dockerhub-fallback"; imageTags: Record<ServiceName, string> }
  | { status: "version-not-found" };

function dockerhubImageTags(version: string): Record<ServiceName, string> {
  return {
    assistant: `${DOCKERHUB_IMAGES.assistant}:${version}`,
    "credential-executor": `${DOCKERHUB_IMAGES["credential-executor"]}:${version}`,
    gateway: `${DOCKERHUB_IMAGES.gateway}:${version}`,
  };
}

/**
 * Resolve image references for a given version, distinguishing why the
 * platform refs were unavailable:
 *
 *   - `platform` — release found; GCR digest-based refs (credential-executor
 *     falls back to DockerHub per-service when its ref is null).
 *   - `dockerhub-fallback` — platform unreachable or responded non-OK;
 *     tag-based DockerHub refs.
 *   - `version-not-found` — the platform answered but the version is absent
 *     from the releases list (likely a typo'd --version).
 */
export async function resolveImageRefsDetailed(
  version: string,
  log?: (msg: string) => void,
): Promise<ImageRefResolution> {
  log?.("Resolving image references...");

  const releases = await fetchReleases();
  if (releases === null) {
    log?.("Platform unreachable — falling back to DockerHub tags");
    return {
      status: "dockerhub-fallback",
      imageTags: dockerhubImageTags(version),
    };
  }

  const normalizedVersion = stripVersionPrefix(version);
  const release = releases.find(
    (r) => stripVersionPrefix(r.version ?? "") === normalizedVersion,
  );

  if (!release) {
    log?.(`Version ${version} not found in platform releases`);
    return { status: "version-not-found" };
  }

  const assistantImage = release.assistant_image_ref;
  const gatewayImage = release.gateway_image_ref;
  let credentialExecutorImage = release.credential_executor_image_ref;

  // Assistant and gateway images are required; a release missing them is a
  // platform data gap, not a user typo — fall back to DockerHub tags.
  if (!assistantImage || !gatewayImage) {
    log?.("Platform release missing required image refs");
    return {
      status: "dockerhub-fallback",
      imageTags: dockerhubImageTags(version),
    };
  }

  if (!credentialExecutorImage) {
    credentialExecutorImage = `${DOCKERHUB_IMAGES["credential-executor"]}:${version}`;
    log?.(
      "credential-executor image not in platform release, using DockerHub fallback",
    );
  }

  return {
    status: "platform",
    imageTags: {
      assistant: assistantImage,
      "credential-executor": credentialExecutorImage,
      gateway: gatewayImage,
    },
  };
}

/**
 * Resolve image references for a given version.
 *
 * Lenient wrapper around {@link resolveImageRefsDetailed}: maps
 * `version-not-found` to the DockerHub fallback so existing callers
 * (start flows, docker rollback) keep their permissive behavior. The
 * upgrade command uses the detailed variant to fail fast on typos.
 */
export async function resolveImageRefs(
  version: string,
  log?: (msg: string) => void,
): Promise<ResolvedImageRefs> {
  const resolution = await resolveImageRefsDetailed(version, log);
  if (resolution.status === "platform") {
    log?.("Resolved image refs from platform API");
    return { imageTags: resolution.imageTags, source: "platform" };
  }
  if (resolution.status === "version-not-found") {
    log?.("Falling back to DockerHub tags");
    return { imageTags: dockerhubImageTags(version), source: "dockerhub" };
  }
  return { imageTags: resolution.imageTags, source: "dockerhub" };
}
