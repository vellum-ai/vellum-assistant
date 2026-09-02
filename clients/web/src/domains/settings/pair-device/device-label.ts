/**
 * Parses a stored (server-recorded) User-Agent string into a browser and OS
 * label, e.g. "Chrome" on "macOS".
 *
 * This is deliberately NOT built on top of `@/runtime/platform-detection.ts`.
 * That module reads `navigator` to describe the browser it is currently
 * running in; it cannot parse an arbitrary User-Agent string captured from a
 * different device at pairing time. Do not "deduplicate" the two: they solve
 * different problems.
 *
 * Returns structured parts rather than a composed sentence so the caller can
 * compose the final label with an ICU message (i18n stays out of this file).
 */

export interface DeviceUserAgentParts {
  browser: string | null;
  os: string | null;
}

function detectOS(userAgent: string): string | null {
  if (/iPhone|iPod/.test(userAgent)) {
    return "iPhone";
  }
  if (/iPad/.test(userAgent)) {
    return "iPad";
  }
  if (/Macintosh/.test(userAgent) && /Mobile/.test(userAgent)) {
    return "iPad";
  }
  if (/Android/.test(userAgent)) {
    return "Android";
  }
  if (/Macintosh|Mac OS X/.test(userAgent)) {
    return "macOS";
  }
  if (/Windows/.test(userAgent)) {
    return "Windows";
  }
  if (/CrOS/.test(userAgent)) {
    return "ChromeOS";
  }
  if (/Linux/.test(userAgent)) {
    return "Linux";
  }
  return null;
}

function detectBrowser(userAgent: string): string | null {
  if (/Edg\/|EdgA\/|EdgiOS\//.test(userAgent)) {
    return "Edge";
  }
  if (/OPR\/|OPiOS\//.test(userAgent)) {
    return "Opera";
  }
  if (/Firefox\/|FxiOS\//.test(userAgent)) {
    return "Firefox";
  }
  if (/Chrome\/|CriOS\//.test(userAgent)) {
    return "Chrome";
  }
  if (/Safari\//.test(userAgent)) {
    return "Safari";
  }
  return null;
}

/**
 * Resolves a stored User-Agent into a browser and OS, or `null` if the input
 * is blank or neither could be identified. Never returns a partially-empty
 * object; callers that get `null` should fall back to a platform label.
 */
export function labelFromUserAgent(
  userAgent: string | null | undefined,
): DeviceUserAgentParts | null {
  if (!userAgent || userAgent.trim() === "") {
    return null;
  }

  const os = detectOS(userAgent);
  const browser = detectBrowser(userAgent);

  if (os === null && browser === null) {
    return null;
  }

  return { browser, os };
}
