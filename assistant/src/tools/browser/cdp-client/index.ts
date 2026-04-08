export { CdpError, type CdpErrorCode } from "./errors.js";
export {
  createExtensionCdpClient,
  ExtensionCdpClient,
} from "./extension-cdp-client.js";
export { getCdpClient } from "./factory.js";
export { createLocalCdpClient, LocalCdpClient } from "./local-cdp-client.js";
export type { CdpClient, CdpClientKind, ScopedCdpClient } from "./types.js";
