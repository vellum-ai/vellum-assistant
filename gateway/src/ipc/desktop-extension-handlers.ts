import { ProvisionDesktopExtensionParamsSchema } from "@vellumai/gateway-client";

import { desktopExtensionSecurity } from "../desktop/desktop-extension-security.js";
import { ipcRoute } from "./server.js";

export const desktopExtensionRoutes = [
  ipcRoute({
    method: "provision_desktop_extension",
    schema: ProvisionDesktopExtensionParamsSchema,
    handler: ({ zip }) =>
      desktopExtensionSecurity.provision(Buffer.from(zip, "base64")),
  }),
];
