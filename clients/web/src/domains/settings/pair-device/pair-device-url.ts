import type { RemoteWebPairingChallengeResponse } from "@vellumai/service-contracts/remote-web-pairing";

/**
 * Public-URL validation and pair-link construction for the "Pair a device"
 * settings section. These mirror the semantics of the `vellum pair --qr` CLI
 * flow (`cli/src/commands/pair.ts`: `normalizePublicBaseUrl`,
 * `resolveQrPublicBaseUrl`, `buildRemoteWebPairingUrl`) so the browser mint and
 * the CLI mint accept the same URLs and produce the same pair links. They live
 * here rather than being imported because the CLI is a separate Node package the
 * browser bundle cannot depend on.
 */

/** Why a pasted public URL can't be used to pair a phone. */
export type PublicBaseUrlRejection = "unparseable" | "loopback" | "non-https";

export type PublicBaseUrlResult =
  | { ok: true; url: string }
  | { ok: false; reason: PublicBaseUrlRejection };

/**
 * A loopback URL — `localhost`, `[::1]`, or `127.x.x.x`. A QR encoding a
 * loopback link is unscannable from another device, so it is refused.
 */
export function isLoopbackUrl(url: string): boolean {
  try {
    // WHATWG URL canonicalizes hostnames, so IPv6 loopback is always "[::1]".
    const hostname = new URL(url).hostname;
    return (
      hostname === "localhost" ||
      hostname === "[::1]" ||
      /^127(?:\.\d{1,3}){3}$/.test(hostname)
    );
  } catch {
    return false;
  }
}

/**
 * Normalize a pasted address to the public origin a scanning phone opens:
 * query/hash stripped, the `assistant` path segment (and anything after it)
 * removed so a pasted pair-page URL collapses to its base, and trailing slashes
 * trimmed. Throws if the value is not a parseable URL.
 */
export function normalizePublicBaseUrl(value: string): string {
  const url = new URL(value);
  url.search = "";
  url.hash = "";
  const parts = url.pathname.split("/").filter(Boolean);
  const assistantIndex = parts.indexOf("assistant");
  if (assistantIndex >= 0) {
    parts.splice(assistantIndex);
  }
  url.pathname = parts.length ? `/${parts.join("/")}` : "/";
  return url.toString().replace(/\/+$/, "");
}

/**
 * Resolve a pasted address to the public https base URL to advertise in the
 * pairing challenge, or report why it can't be used. Stricter than a plain
 * parse: a loopback or non-https link is unreachable from another device, so
 * both are refused with a specific reason the UI turns into an inline message.
 */
export function resolvePublicBaseUrl(raw: string): PublicBaseUrlResult {
  let normalized: string;
  try {
    normalized = normalizePublicBaseUrl(raw);
  } catch {
    return { ok: false, reason: "unparseable" };
  }
  if (isLoopbackUrl(normalized)) {
    return { ok: false, reason: "loopback" };
  }
  if (new URL(normalized).protocol !== "https:") {
    return { ok: false, reason: "non-https" };
  }
  return { ok: true, url: normalized };
}

/** Inline validation message for each rejection reason. */
export function publicBaseUrlRejectionMessage(
  reason: PublicBaseUrlRejection,
): string {
  switch (reason) {
    case "unparseable":
      return "Enter a valid URL, e.g. https://your-assistant.ts.net.";
    case "loopback":
      return "This is a loopback address your phone can't reach. Enter the assistant's public https URL.";
    case "non-https":
      return "The URL must use https so your phone can connect securely.";
  }
}

/**
 * The scannable pair URL: the challenge's verification URI with the device code
 * carried in the fragment (`#device_code=…`), matching what the pair page reads
 * on load.
 */
export function buildRemoteWebPairingUrl(
  challenge: Pick<
    RemoteWebPairingChallengeResponse,
    "verificationUri" | "deviceCode"
  >,
): string {
  const url = new URL(challenge.verificationUri);
  url.hash = new URLSearchParams({
    device_code: challenge.deviceCode,
  }).toString();
  return url.toString();
}
