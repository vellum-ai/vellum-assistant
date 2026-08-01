import { resolveIpcEndpoint } from "@vellumai/ipc-server-utils";
import { getWorkspaceDir } from "../paths.js";
export function resolveIpcSocketPath(socketName: string): {
  path: string;
  source: string;
} {
  return resolveIpcEndpoint(socketName, { workspaceDir: getWorkspaceDir() });
}
