import { ROUTES } from "../../runtime/routes/index.js";
import type { IpcRoute } from "../assistant-server.js";
import { routeDefinitionsToIpcRoutes } from "./route-adapter.js";

/** All built-in CLI IPC routes. */
export const cliIpcRoutes: IpcRoute[] = [
  ...routeDefinitionsToIpcRoutes(ROUTES),
];
