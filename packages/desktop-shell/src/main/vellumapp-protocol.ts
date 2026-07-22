/**
 * Protocol handler for `vellumapp://` — serves bundle assets from
 * `userData/bundles/{uuid}/`. The hostname of the URL is the bundle
 * UUID; the pathname maps to a file inside that bundle directory.
 *
 * Same structural pattern as `app-protocol.ts`: the core path-resolution
 * logic is pure (no Electron imports) so tests can exercise it without
 * standing up the full main-process lifecycle. The Electron-dependent
 * `registerVellumAppProtocol` wires the pure logic into `protocol.handle`.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { net, protocol } from "electron";

import { VELLUMAPP_PROTOCOL } from "./app-config";
import { resolveRelativePath } from "./app-protocol";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".ico": "image/x-icon",
};

export const mimeTypeForPath = (filePath: string): string =>
  MIME_TYPES[path.extname(filePath).toLowerCase()] ??
  "application/octet-stream";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ResolveBundleResult =
  | { kind: "ok"; uuid: string; resolved: string }
  | { kind: "forbidden" };

export const resolveBundlePath = (
  bundlesRoot: string,
  requestUrl: string,
): ResolveBundleResult => {
  const url = new URL(requestUrl);
  const uuid = url.hostname;

  if (!UUID_RE.test(uuid)) {
    return { kind: "forbidden" };
  }

  const bundleRoot = path.join(bundlesRoot, uuid);

  let relativePath: string;
  try {
    relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  } catch {
    return { kind: "forbidden" };
  }

  const result = resolveRelativePath(bundleRoot, relativePath);
  if (result.kind === "forbidden") {
    return { kind: "forbidden" };
  }

  return { kind: "ok", uuid, resolved: result.resolved };
};

export const createVellumAppHandler =
  (bundlesRoot: string) =>
  async (request: Request): Promise<Response> => {
    const result = resolveBundlePath(bundlesRoot, request.url);
    if (result.kind === "forbidden") {
      return new Response("Forbidden", { status: 403 });
    }

    const { resolved } = result;

    try {
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) {
        return new Response("Not Found", { status: 404 });
      }
    } catch {
      return new Response("Not Found", { status: 404 });
    }

    const response = await net.fetch(pathToFileURL(resolved).toString());
    return new Response(response.body, {
      status: response.status,
      headers: {
        "Content-Type": mimeTypeForPath(resolved),
      },
    });
  };

export const registerVellumAppProtocol = (bundlesRoot: string): void => {
  protocol.handle(VELLUMAPP_PROTOCOL, createVellumAppHandler(bundlesRoot));
};
