import type { ClientOs, InterfaceId } from "../channels/types.js";

/** Public download page for the desktop apps. */
export const DESKTOP_APP_DOWNLOAD_URL = "https://www.vellum.ai/downloads";

/** Chrome Web Store listing for the Vellum Assistant browser extension. */
export const CHROME_WEB_STORE_INSTALL_URL =
  "https://chromewebstore.google.com/detail/vellum-assistant-browser/hphbdmpffeigpcdjkckleobjmhhokpne";

export const DESKTOP_APP_INSTALL_HINT = `Install the Vellum desktop app: ${DESKTOP_APP_DOWNLOAD_URL}`;

/** User-facing install step for status userActions and command-failure hints. */
export const CHROME_EXTENSION_INSTALL_HINT = `Install the Vellum Assistant Chrome extension from the Chrome Web Store: ${CHROME_WEB_STORE_INSTALL_URL}`;

export interface CapabilityOfferSurface {
  transportInterface?: InterfaceId;
  clientOs?: ClientOs;
}

const LOGGED_IN_BROWSER_HELPFUL_RE =
  /timed?\s*out|timeout|etimedout|econnrefused|enotfound|ehostunreach|unreachable|err_connection|err_name_not_resolved|err_timed_out|net::err_|login required|sign[- ]in required|\b401\b|\b403\b|authentication|captcha|verify you are human|access denied|forbidden/i;

/**
 * True on phone transports and mobile client OS values. Those surfaces have
 * no in-app browser and cannot install the Chrome extension in-place.
 */
export function isPhoneSurface(surface?: CapabilityOfferSurface): boolean {
  if (
    surface?.transportInterface === "ios" ||
    surface?.transportInterface === "phone"
  ) {
    return true;
  }
  return surface?.clientOs === "ios" || surface?.clientOs === "android";
}

/**
 * True when a logged-in browser session (desktop app or Chrome extension)
 * would plausibly reach the page this failure could not.
 */
export function shouldOfferLoggedInBrowser(message: string): boolean {
  return LOGGED_IN_BROWSER_HELPFUL_RE.test(message);
}

/**
 * Offer the desktop app and Chrome extension as a capability the user can
 * turn on. Screenshot-and-paste is the fallback after that offer, not the
 * first suggestion.
 */
export function formatLoggedInBrowserOffer(
  surface?: CapabilityOfferSurface,
): string {
  const lines: string[] = [];
  if (isPhoneSurface(surface)) {
    lines.push(
      "This page needs a logged-in browser on a computer. There is no in-app browser on this phone, and the Chrome extension cannot be installed here.",
    );
    lines.push(
      `Install the desktop app on a Mac or Windows PC (${DESKTOP_APP_DOWNLOAD_URL}) or the Chrome extension in Chrome on that computer (${CHROME_WEB_STORE_INSTALL_URL}).`,
    );
    lines.push(
      "Offer those first. Do not describe a browser panel here. Only ask for a screenshot or pasted page content if the user cannot install either.",
    );
    return lines.join("\n");
  }

  lines.push(
    "A connected desktop app or Chrome extension can open this page in a browser where you are already logged in.",
  );
  lines.push(`Desktop app: ${DESKTOP_APP_DOWNLOAD_URL}`);
  lines.push(`Chrome extension: ${CHROME_WEB_STORE_INSTALL_URL}`);
  lines.push(
    "Offer those first. Only ask for a screenshot or pasted page content if the user cannot install either.",
  );
  return lines.join("\n");
}

/**
 * Append {@link formatLoggedInBrowserOffer} when the message does not already
 * carry the install URLs.
 */
export function appendLoggedInBrowserOffer(
  message: string,
  surface?: CapabilityOfferSurface,
): string {
  if (
    message.includes(DESKTOP_APP_DOWNLOAD_URL) &&
    message.includes(CHROME_WEB_STORE_INSTALL_URL)
  ) {
    return message;
  }
  return `${message}\n\n${formatLoggedInBrowserOffer(surface)}`;
}
