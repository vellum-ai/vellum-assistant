/// <reference path="./bun-test-shim.d.ts" />

/**
 * Minimal ambient declarations for the subset of the Chrome Extension API
 * surface used by the Vellum browser-relay extension's typed modules.
 *
 * This is intentionally narrow — it covers what's needed by
 * background/cloud-auth.ts, background/self-hosted-auth.ts, and their tests.
 * The full @types/chrome package is an option for the future if we type-check
 * more of the package.
 */

declare namespace chrome {
  namespace storage {
    interface StorageArea {
      get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
      clear(): Promise<void>;
    }
    const local: StorageArea;
    const sync: StorageArea;
    const session: StorageArea;
  }

  namespace identity {
    interface WebAuthFlowDetails {
      url: string;
      interactive?: boolean;
    }
    function getRedirectURL(path?: string): string;
    function launchWebAuthFlow(details: WebAuthFlowDetails): Promise<string | undefined>;
  }

  namespace runtime {
    interface LastError {
      message?: string;
    }
    const lastError: LastError | undefined;

    interface PortMessageEvent {
      addListener(listener: (message: unknown) => void): void;
      removeListener(listener: (message: unknown) => void): void;
    }

    interface PortDisconnectEvent {
      addListener(listener: (port: Port) => void): void;
      removeListener(listener: (port: Port) => void): void;
    }

    interface Port {
      name: string;
      onMessage: PortMessageEvent;
      onDisconnect: PortDisconnectEvent;
      postMessage(message: unknown): void;
      disconnect(): void;
    }

    function connectNative(application: string): Port;
  }
}
