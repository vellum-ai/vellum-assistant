/**
 * The single origin the renderer legitimately runs at, expressed as a
 * structured protocol + host pair rather than a string. Packaged, the
 * renderer loads over the privileged `app://vellum.ai` scheme
 * (registered `standard` + `secure` in `index.ts`), so a frame's
 * `origin` is a real tuple origin. In dev it loads over the Vite /
 * edge-proxy HTTP origin honored from `VELLUM_DEV_URL`.
 */
export interface AllowedOrigin {
  protocol: string;
  host: string;
}

export interface AppOriginOptions {
  appHost: string;
  appProtocol: string;
  getDevRendererBase: () => string;
  isPackaged: () => boolean;
}

/**
 * Resolve the renderer origin for the current build. Read at call time
 * (not cached) so packaged-vs-dev is decided at the moment of the check and
 * a development URL honored mid-process stays authoritative - the same
 * property the navigation guard and the IPC sender guard both rely on.
 */
export const createAllowedOriginResolver =
  (options: AppOriginOptions): (() => AllowedOrigin) =>
  () => {
    if (options.isPackaged()) {
      return {
        protocol: `${options.appProtocol}:`,
        host: options.appHost,
      };
    }
    const devUrl = new URL(options.getDevRendererBase());
    return { protocol: devUrl.protocol, host: devUrl.host };
  };

/**
 * Whether `origin` matches the build's renderer origin. Accepts either
 * a frame's `senderFrame.origin` string (the IPC sender guard) or an
 * already-parsed navigation target `URL` (the navigation guard). The
 * comparison is on the protocol + host tuple, never on `URL.origin`:
 * `app://vellum.ai` is a non-special scheme to WHATWG URL, so its
 * `.origin` is the opaque string `"null"` - protocol + host stays
 * stable and is what Electron exposes for the `standard`-registered
 * scheme. A null/empty or unparseable origin is never allowed.
 */
export const isAllowedOrigin = (
  origin: string | URL | null | undefined,
  allowed: AllowedOrigin,
): boolean => {
  if (!origin) {
    return false;
  }
  let parsed: URL;
  if (origin instanceof URL) {
    parsed = origin;
  } else {
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
  }
  return parsed.protocol === allowed.protocol && parsed.host === allowed.host;
};
