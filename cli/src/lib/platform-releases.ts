import { getPlatformUrl } from "./platform-client.js";
import { DOCKERHUB_IMAGES } from "./docker.js";
import type { ServiceName } from "./docker.js";

export interface ResolvedImageRefs {
  imageTags: Record<ServiceName, string>;
  source: "platform" | "dockerhub";
}

/**
 * Resolve image references for a given version.
 *
 * Tries the platform API first (returns GCR digest-based refs when available).
 * If the exact version isn't found (e.g. a pre-release CLI build), falls back
 * to the latest stable release from the platform API.  DockerHub tag-based refs
 * are only used as a last resort when the platform is entirely unreachable.
 */
export async function resolveImageRefs(
  version: string,
  log?: (msg: string) => void,
): Promise<ResolvedImageRefs> {
  log?.("Resolving image references...");

  const platformRefs = await fetchPlatformImageRefs(version, log);
  if (platformRefs) {
    log?.("Resolved image refs from platform API");
    return { imageTags: platformRefs, source: "platform" };
  }

  log?.("Falling back to DockerHub tags");
  const imageTags: Record<ServiceName, string> = {
    assistant: `${DOCKERHUB_IMAGES.assistant}:${version}`,
    "credential-executor": `${DOCKERHUB_IMAGES["credential-executor"]}:${version}`,
    gateway: `${DOCKERHUB_IMAGES.gateway}:${version}`,
  };
  return { imageTags, source: "dockerhub" };
}

interface PlatformRelease {
  version?: string;
  assistant_image_ref?: string | null;
  gateway_image_ref?: string | null;
  credential_executor_image_ref?: string | null;
}

/**
 * Extract image refs from a platform release entry.
 *
 * Returns a record of service name to image ref, or null if required refs
 * (assistant, gateway) are missing.
 */
function extractImageRefs(
  release: PlatformRelease,
  version: string,
  log?: (msg: string) => void,
): Record<ServiceName, string> | null {
  const assistantImage = release.assistant_image_ref;
  const gatewayImage = release.gateway_image_ref;
  let credentialExecutorImage = release.credential_executor_image_ref;

  if (!assistantImage || !gatewayImage) {
    log?.("Platform release missing required image refs");
    return null;
  }

  if (!credentialExecutorImage) {
    credentialExecutorImage = `${DOCKERHUB_IMAGES["credential-executor"]}:v${version}`;
    log?.(
      "credential-executor image not in platform release, using DockerHub fallback",
    );
  }

  return {
    assistant: assistantImage,
    "credential-executor": credentialExecutorImage,
    gateway: gatewayImage,
  };
}

/**
 * Fetch image references from the platform releases API.
 *
 * Returns a record of service name to image ref (GCR digest-based) for the
 * given version.  When the exact version isn't found (e.g. pre-release CLI),
 * falls back to the latest stable release.  Returns null only when the
 * platform is entirely unreachable or returns no usable releases.
 */
async function fetchPlatformImageRefs(
  version: string,
  log?: (msg: string) => void,
): Promise<Record<ServiceName, string> | null> {
  try {
    const platformUrl = getPlatformUrl();
    const url = `${platformUrl}/v1/releases/?stable=true`;

    log?.(`Fetching releases from ${url}`);

    const response = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      log?.(`Platform API returned ${response.status}`);
      return null;
    }

    const releases = (await response.json()) as PlatformRelease[];

    // Strip leading "v" from the requested version for matching
    const normalizedVersion = version.replace(/^v/, "");

    const release = releases.find((r) => {
      const releaseVersion = (r.version ?? "").replace(/^v/, "");
      return releaseVersion === normalizedVersion;
    });

    if (!release) {
      log?.(`Version ${version} not found in platform releases`);

      // The CLI version may be ahead of the latest published release (e.g. a
      // pre-release build).  Rather than falling all the way back to DockerHub
      // tags (which also won't exist for an unpublished version), use the most
      // recent stable release from the list we already fetched.
      const latest = releases[0];
      if (!latest) {
        log?.("No stable releases available from platform");
        return null;
      }
      const latestVersion = (latest.version ?? "unknown").replace(/^v/, "");
      log?.(`Falling back to latest stable release: ${latestVersion}`);
      return extractImageRefs(latest, latestVersion, log);
    }

    return extractImageRefs(release, normalizedVersion, log);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log?.(`Platform image ref resolution failed: ${message}`);
    return null;
  }
}
