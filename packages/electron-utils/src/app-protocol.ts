import { stat } from "node:fs/promises";
import path from "node:path";

/** Resolves renderer paths without allowing traversal outside the root. */
export type ResolveResult =
  | { kind: "ok"; resolved: string }
  | { kind: "forbidden" };

export interface AppProtocolOrigin {
  protocol: string;
  host: string;
}

export type AppProtocolAssetPlan =
  | { kind: "fetch"; path: string }
  | { kind: "forbidden" }
  | { kind: "not-found" };

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
  allowedOrigin?: AppProtocolOrigin,
): ResolveResult => {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return { kind: "forbidden" };
  }
  if (
    allowedOrigin &&
    (url.protocol !== allowedOrigin.protocol || url.host !== allowedOrigin.host)
  ) {
    return { kind: "forbidden" };
  }
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

export const planAppProtocolAssetRequest = async (options: {
  rendererRoot: string;
  indexHtml: string;
  requestUrl: string;
  mountPrefix?: string;
  allowedOrigin?: AppProtocolOrigin;
  isFile?: (candidate: string) => Promise<boolean>;
}): Promise<AppProtocolAssetPlan> => {
  const result = resolveAppProtocolPath(
    options.rendererRoot,
    options.requestUrl,
    options.mountPrefix,
    options.allowedOrigin,
  );
  if (result.kind === "forbidden") {
    return result;
  }
  const isFile =
    options.isFile ??
    (async (candidate: string): Promise<boolean> => {
      try {
        return (await stat(candidate)).isFile();
      } catch {
        return false;
      }
    });
  if (await isFile(result.resolved)) {
    return { kind: "fetch", path: result.resolved };
  }
  const extension = path.extname(result.resolved);
  if (extension === "" || extension === ".html") {
    return { kind: "fetch", path: options.indexHtml };
  }
  return { kind: "not-found" };
};
