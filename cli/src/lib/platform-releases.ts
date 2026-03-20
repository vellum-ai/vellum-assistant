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
 * Tries the platform API first (returns GCR digest-based refs when available),
 * then falls back to DockerHub tag-based refs when the platform is unreachable
 * or the version is not found.
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
  const versionTag = version.replace(/^v/, "");
  const imageTags: Record<ServiceName, string> = {
    assistant: `${DOCKERHUB_IMAGES.assistant}:v${versionTag}`,
    "credential-executor": `${DOCKERHUB_IMAGES["credential-executor"]}:v${versionTag}`,
    gateway: `${DOCKERHUB_IMAGES.gateway}:v${versionTag}`,
  };
  return { imageTags, source: "dockerhub" };
}

/**
 * Fetch image references from the platform releases API.
 *
 * Returns a record of service name to image ref (GCR digest-based) for the
 * given version, or null if the platform is unreachable, the version is not
 * found, or any error occurs.
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

    const releases = (await response.json()) as Array<{
      version?: string;
      assistant_image?: string | null;
      gateway_image?: string | null;
      credential_executor_image?: string | null;
    }>;

    // Strip leading "v" from the requested version for matching
    const normalizedVersion = version.replace(/^v/, "");

    const release = releases.find((r) => {
      const releaseVersion = (r.version ?? "").replace(/^v/, "");
      return releaseVersion === normalizedVersion;
    });

    if (!release) {
      log?.(`Version ${version} not found in platform releases`);
      return null;
    }

    const assistantImage = release.assistant_image;
    const gatewayImage = release.gateway_image;
    let credentialExecutorImage = release.credential_executor_image;

    // All three images must be present for a valid resolution
    if (!assistantImage || !gatewayImage) {
      log?.("Platform release missing required image refs");
      return null;
    }

    // Fall back to DockerHub for credential-executor if its image ref is null
    if (!credentialExecutorImage) {
      const versionTag = normalizedVersion;
      credentialExecutorImage = `${DOCKERHUB_IMAGES["credential-executor"]}:v${versionTag}`;
      log?.(
        "credential-executor image not in platform release, using DockerHub fallback",
      );
    }

    return {
      assistant: assistantImage,
      "credential-executor": credentialExecutorImage,
      gateway: gatewayImage,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log?.(`Platform image ref resolution failed: ${message}`);
    return null;
  }
}
