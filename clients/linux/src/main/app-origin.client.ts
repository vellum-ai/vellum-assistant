import { app } from "electron";

import {
  createAllowedOriginResolver,
  isAllowedOrigin,
  type AllowedOrigin,
} from "@vellumai/electron-desktop/app-origin";

import {
  APP_HOST,
  APP_PROTOCOL,
  getDevRendererBase,
  usesAppProtocolRenderer,
} from "./app-config";

export type { AllowedOrigin };
export { isAllowedOrigin };

export const resolveAllowedOrigin = createAllowedOriginResolver({
  appHost: APP_HOST,
  appProtocol: APP_PROTOCOL,
  getDevRendererBase,
  isPackaged: () => usesAppProtocolRenderer(app.isPackaged),
});
