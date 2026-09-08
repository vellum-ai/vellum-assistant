/**
 * The `vellum_preview` cookie is what this browser asked the origin to serve.
 * `VITE_CHANNEL` is what the running bundle was built as. They can disagree.
 */

/** Set to `1` to opt into the preview build. */
export const PREVIEW_COOKIE = "vellum_preview";

const PREVIEW_COOKIE_ATTRS = "path=/; Secure; SameSite=Lax";
const ONE_YEAR_SECONDS = 31536000;
const EXPIRED_COOKIE_DATE = "Thu, 01 Jan 1970 00:00:00 GMT";

export type Channel = "preview" | "stable";

/** Whether this browser has opted into the preview build. */
export function isPreviewRequested(): boolean {
  try {
    return document.cookie
      .split(";")
      .some((row) => row.trim() === `${PREVIEW_COOKIE}=1`);
  } catch {
    // Cookie access throws in embeddings that block storage.
    return false;
  }
}

/** Opt this browser into or out of the preview build. Takes effect on the next load. */
export function setPreviewRequested(on: boolean): void {
  // A past expiry clears the cookie.
  const lifetime = on
    ? `max-age=${ONE_YEAR_SECONDS}`
    : `expires=${EXPIRED_COOKIE_DATE}`;
  try {
    document.cookie = `${PREVIEW_COOKIE}=1; ${PREVIEW_COOKIE_ATTRS}; ${lifetime}`;
  } catch {
    // Storage blocked, same as the read above.
  }
}

/** The channel and version this bundle was built as. */
export function getRunningChannel(): {
  channel: Channel;
  version: string | null;
} {
  return {
    channel: import.meta.env.VITE_CHANNEL === "preview" ? "preview" : "stable",
    version: import.meta.env.VITE_APP_VERSION ?? null,
  };
}
