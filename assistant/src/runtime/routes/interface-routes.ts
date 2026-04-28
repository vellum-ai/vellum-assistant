/**
 * GET /v1/interfaces/:path*
 *
 * Serves interface definition files from the workspace's `interfaces/`
 * directory. Returns the raw file content as `text/plain`.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { getInterfacesDir } from "../../util/platform.js";
import { NotFoundError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "getInterface",
    endpoint: "interfaces/:path*",
    method: "GET",
    policyKey: "interfaces",
    summary: "Serve an interface definition file",
    tags: ["interfaces"],
    responseHeaders: { "Content-Type": "text/plain; charset=utf-8" },
    handler: ({ pathParams }) => {
      const interfacePath = pathParams?.path;
      if (!interfacePath) {
        throw new NotFoundError("Interface not found");
      }

      const interfacesDir = getInterfacesDir();
      const fullPath = resolve(interfacesDir, interfacePath);
      if (
        (fullPath !== interfacesDir &&
          !fullPath.startsWith(interfacesDir + "/")) ||
        !existsSync(fullPath)
      ) {
        throw new NotFoundError("Interface not found");
      }

      return readFileSync(fullPath, "utf-8");
    },
  },
];
