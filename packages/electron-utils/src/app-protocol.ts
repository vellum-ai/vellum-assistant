import path from "node:path";

/** Resolves renderer paths without allowing traversal outside the root. */
export type ResolveResult =
  | { kind: "ok"; resolved: string }
  | { kind: "forbidden" };

export const resolveRelativePath = (
  rendererRoot: string,
  relativePath: string,
): ResolveResult => {
  const resolved = path.normalize(path.join(rendererRoot, relativePath));
  const rendererRootWithSep = rendererRoot + path.sep;
  if (
    resolved !== rendererRoot &&
    !resolved.startsWith(rendererRootWithSep)
  ) {
    return { kind: "forbidden" };
  }
  return { kind: "ok", resolved };
};

export const resolveAppProtocolPath = (
  rendererRoot: string,
  requestUrl: string,
  mountPrefix?: string,
): ResolveResult => {
  const url = new URL(requestUrl);
  // Strip the renderer's URL mount before resolving against its disk root.
  let pathname = url.pathname;
  if (mountPrefix) {
    if (pathname === mountPrefix) {
      pathname = "/";
    } else if (pathname.startsWith(`${mountPrefix}/`)) {
      pathname = pathname.slice(mountPrefix.length);
    }
  }
  let relativePath: string;
  try {
    relativePath = decodeURIComponent(pathname).replace(/^\/+/, "");
  } catch {
    // Treat malformed percent-encoding as a forbidden path.
    return { kind: "forbidden" };
  }
  return resolveRelativePath(rendererRoot, relativePath);
};
