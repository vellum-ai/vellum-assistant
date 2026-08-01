import { createIpcRegistrar } from "@vellumai/electron-desktop/ipc";

import { resolveAllowedOrigin } from "./app-origin.client";

export const { handle, handleSync, on } =
  createIpcRegistrar(resolveAllowedOrigin);
