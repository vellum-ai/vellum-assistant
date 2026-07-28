/**
 * Channel-neutral deep-link pair into an external client — a native app URL
 * (e.g. `slack://…`) and/or a browser URL. Mirrors the daemon's
 * `externalSourceLinkSchema` on the conversation channel binding; also the
 * shape of Slack's per-message and per-thread links.
 */
export interface ExternalSourceLink {
  appUrl?: string;
  webUrl?: string;
}

export function getExternalLinkUrl(
  link: ExternalSourceLink | null | undefined,
): string | undefined {
  return link?.webUrl ?? link?.appUrl;
}
