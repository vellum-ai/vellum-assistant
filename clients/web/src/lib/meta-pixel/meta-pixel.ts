const PIXEL_ID = "917410754724056";

interface FbqPixel {
  (...args: unknown[]): void;
  callMethod?: (...args: unknown[]) => void;
  queue: unknown[][];
  push: FbqPixel;
  loaded: boolean;
  version: string;
}

let initialized = false;

/**
 * Injects the Meta Pixel base script and initializes the pixel.
 * Only runs on vellum.ai (no dev, staging, or Electron).
 */
export function initMetaPixel(): void {
  if (initialized) {
    return;
  }

  const host = window.location.hostname;
  if (host !== "vellum.ai" && host !== "www.vellum.ai") {
    return;
  }

  initialized = true;

  const n = (window.fbq = function (...args: unknown[]) {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    n.callMethod
      ? n.callMethod(...args)
      : n.queue.push(args);
  } as FbqPixel);
  n.push = n;
  n.loaded = true;
  n.version = "2.0";
  n.queue = [] as unknown[][];

  const s = document.createElement("script");
  s.async = true;
  s.src = "https://connect.facebook.net/en_US/fbevents.js";
  document.head.appendChild(s);

  window.fbq("init", PIXEL_ID);
}

/** Fires a CompleteRegistration standard event if the pixel is initialized. */
export function trackCompleteRegistration(): void {
  if (!initialized) {
    return;
  }
  window.fbq!("track", "CompleteRegistration");
}
