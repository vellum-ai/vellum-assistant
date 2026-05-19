/**
 * Client for the host-side image-loader endpoint that the `vel up` watcher
 * runs alongside its minikube watchers. Used by the docker hatch path to
 * acquire image refs that aren't pullable from any external registry.
 *
 * The endpoint URL is a hardcoded convention — port 5500 on 127.0.0.1,
 * matching the constant baked into the vel package. The OSS CLI calls in
 * whenever it sees an image ref it recognizes as a local build
 * (`vellum-local/*`), since those tags only exist in minikube's internal
 * docker daemon and can't be `docker pull`'d.
 *
 * The endpoint contract is intentionally minimal — POST a ref as JSON, get
 * back a 200 once the image is in the host docker daemon, or a non-2xx
 * with a descriptive error message. The CLI doesn't know (or care) what
 * transport the server uses to put the image there.
 */

/**
 * Well-known URL of the host-side image-loader started by `vel up`. The same
 * port + path are hardcoded in vel's `host-image-server.ts` — keep them in
 * sync if you change either side.
 */
export const HOST_IMAGE_LOADER_URL = "http://127.0.0.1:5500/v1/images/load";

/**
 * Prefix for image refs that only live in the `vel up` minikube daemon.
 * These cannot be `docker pull`'d from any external registry; the CLI must
 * route them through the host image-loader instead.
 */
const LOCAL_BUILD_REF_PREFIX = "vellum-local/";

/** Whether `ref` points at a `vel up`-built image that requires the host loader. */
export function isLocalBuildRef(ref: string): boolean {
  return ref.startsWith(LOCAL_BUILD_REF_PREFIX);
}

/** Default timeout for image-load requests. Large `docker save | docker load`
 * pipelines for full assistant images can run for a minute or two on cold
 * caches, so we give plenty of headroom. */
const LOAD_TIMEOUT_MS = 120_000;

export interface HostImageLoaderResponse {
  loaded?: boolean;
  ref?: string;
  error?: string;
}

export class HostImageLoaderError extends Error {
  readonly url: string;
  readonly ref: string;
  readonly status?: number;

  constructor(message: string, url: string, ref: string, status?: number) {
    super(message);
    this.name = "HostImageLoaderError";
    this.url = url;
    this.ref = ref;
    this.status = status;
  }
}

function isConnectionRefused(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { cause?: { code?: string }; code?: string };
  return e.cause?.code === "ECONNREFUSED" || e.code === "ECONNREFUSED";
}

/**
 * Ask the host-side loader to acquire `ref` into the host docker daemon.
 *
 * Resolves when the server returns 200; throws a {@link HostImageLoaderError}
 * with a user-actionable message on any failure (network, timeout, non-2xx).
 *
 * The `log` callback receives one-line status updates; pass the same logger
 * the surrounding command uses.
 */
/** Minimal fetch signature accepted for test injection. */
export type FetchLike = (
  input: string | URL,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<Response>;

export async function loadImageViaHost(
  url: string,
  ref: string,
  log: (msg: string) => void,
  options: { timeoutMs?: number; fetchImpl?: FetchLike } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? LOAD_TIMEOUT_MS;
  const fetchImpl: FetchLike =
    options.fetchImpl ?? (fetch as unknown as FetchLike);

  log(`   ↪ ${ref}`);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (isConnectionRefused(err)) {
      throw new HostImageLoaderError(
        `Could not reach image-loader at ${url}. The ref \`${ref}\` looks ` +
          `like a \`vel up\`-local build that needs the host loader. ` +
          `Is \`vel up\` running? Start it, or set VELLUM_ASSISTANT_IMAGE / ` +
          `VELLUM_GATEWAY_IMAGE / VELLUM_CREDENTIAL_EXECUTOR_IMAGE to bypass ` +
          `platform image resolution.`,
        url,
        ref,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new HostImageLoaderError(
      `Image-loader request for ${ref} failed: ${message}`,
      url,
      ref,
    );
  }

  if (!response.ok) {
    let body: HostImageLoaderResponse | null = null;
    try {
      body = (await response.json()) as HostImageLoaderResponse;
    } catch {
      // Server returned non-JSON; fall through with status-only error.
    }
    const detail = body?.error ? `: ${body.error}` : "";
    throw new HostImageLoaderError(
      `Image-loader returned HTTP ${response.status} for ${ref}${detail}`,
      url,
      ref,
      response.status,
    );
  }
}
