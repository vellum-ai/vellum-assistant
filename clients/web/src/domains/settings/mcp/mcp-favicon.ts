const LOCAL_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
  ".home",
  ".home.arpa",
  ".ts.net",
];

/** Best-effort favicons use public DNS origins and never expose endpoint paths. */
export function getMcpFaviconUrl(endpointUrl?: string): string | null {
  if (!endpointUrl) {
    return null;
  }
  try {
    const url = new URL(endpointUrl);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !/^https:\/\//i.test(endpointUrl) ||
      /[\u0000-\u0020\\]/.test(endpointUrl) ||
      !host.includes(".") ||
      /^[\d.]+$/.test(host) ||
      host.startsWith("[") ||
      LOCAL_SUFFIXES.some(
        (suffix) => host === suffix.slice(1) || host.endsWith(suffix),
      )
    ) {
      return null;
    }
    return `${url.origin}/favicon.ico`;
  } catch {
    return null;
  }
}
