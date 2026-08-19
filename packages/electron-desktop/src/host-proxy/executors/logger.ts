/**
 * Logger seam for the shared host-proxy executors. Defaults to the console;
 * `installHostProxyBridge` points it at the client's real logger.
 */

import type { HostProxyLogger } from "../router";

let current: HostProxyLogger = console;

export function setHostProxyExecutorLogger(logger: HostProxyLogger): void {
  current = logger;
}

const log = {
  info: (message: string, context?: unknown): void =>
    current.info(message, context),
  warn: (message: string, context?: unknown): void =>
    current.warn(message, context),
  error: (message: string, context?: unknown): void =>
    current.error(message, context),
  debug: (message: string, context?: unknown): void => {
    const debuggable = current as HostProxyLogger & {
      debug?: (message: string, context?: unknown) => void;
    };
    if (debuggable.debug) {
      debuggable.debug(message, context);
    } else {
      debuggable.info(message, context);
    }
  },
};

export default log;
