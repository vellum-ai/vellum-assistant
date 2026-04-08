/// <reference path="./bun-test-shim.d.ts" />

/**
 * Minimal ambient declarations for the subset of the Chrome Extension API
 * surface used by the Vellum browser-relay extension's typed modules.
 *
 * This is intentionally narrow — it covers what's needed by the
 * typechecked files under `background/` and `popup/`, not the full
 * Chrome API surface. The full `@types/chrome` package is an option for
 * the future if we type-check more of the package or need additional
 * API surface that this file doesn't cover.
 *
 * Note: `debugger` is a reserved word in TypeScript so we cannot declare
 * a `namespace chrome.debugger`. Instead, `chrome` is declared as a
 * top-level `const` whose type is an interface — that shape can include
 * a `debugger` property because object literal property names may use
 * reserved words.
 */

interface ChromeStorageArea {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  clear(): Promise<void>;
}

interface ChromeStorageChange {
  newValue?: unknown;
  oldValue?: unknown;
}

type ChromeStorageAreaName = 'local' | 'sync' | 'managed' | 'session';

interface ChromeStorageChangedEvent {
  addListener(
    listener: (
      changes: Record<string, ChromeStorageChange>,
      areaName: ChromeStorageAreaName,
    ) => void,
  ): void;
  removeListener(
    listener: (
      changes: Record<string, ChromeStorageChange>,
      areaName: ChromeStorageAreaName,
    ) => void,
  ): void;
}

interface ChromeStorageNamespace {
  local: ChromeStorageArea;
  sync: ChromeStorageArea;
  session: ChromeStorageArea;
  onChanged: ChromeStorageChangedEvent;
}

interface ChromeIdentityWebAuthFlowDetails {
  url: string;
  interactive?: boolean;
}

interface ChromeIdentityNamespace {
  getRedirectURL(path?: string): string;
  launchWebAuthFlow(details: ChromeIdentityWebAuthFlowDetails): Promise<string | undefined>;
}

interface ChromeRuntimeLastError {
  message?: string;
}

interface ChromeRuntimePortMessageEvent {
  addListener(listener: (message: unknown) => void): void;
  removeListener(listener: (message: unknown) => void): void;
}

interface ChromeRuntimePortDisconnectEvent {
  addListener(listener: (port: ChromeRuntimePort) => void): void;
  removeListener(listener: (port: ChromeRuntimePort) => void): void;
}

interface ChromeRuntimePort {
  name: string;
  onMessage: ChromeRuntimePortMessageEvent;
  onDisconnect: ChromeRuntimePortDisconnectEvent;
  postMessage(message: unknown): void;
  disconnect(): void;
}

interface ChromeRuntimeMessageSender {
  tab?: ChromeTab;
  frameId?: number;
  id?: string;
  url?: string;
  tlsChannelId?: string;
  origin?: string;
}

type ChromeRuntimeMessageListener = (
  message: Record<string, unknown> & { type?: string },
  sender: ChromeRuntimeMessageSender,
  sendResponse: (response?: unknown) => void,
) => boolean | void;

interface ChromeRuntimeOnMessageEvent {
  addListener(listener: ChromeRuntimeMessageListener): void;
  removeListener(listener: ChromeRuntimeMessageListener): void;
}

interface ChromeRuntimeManifest {
  version: string;
  [key: string]: unknown;
}

interface ChromeRuntimeNamespace {
  readonly lastError: ChromeRuntimeLastError | undefined;
  connectNative(application: string): ChromeRuntimePort;
  onMessage: ChromeRuntimeOnMessageEvent;
  // Generic over the response type so callers can narrow the callback
  // argument without casting. Matches the de-facto shape used by the
  // official @types/chrome package.
  sendMessage<TResponse = unknown>(
    message: unknown,
    responseCallback?: (response: TResponse) => void,
  ): void;
  getManifest(): ChromeRuntimeManifest;
}

interface ChromeTab {
  id?: number;
  windowId?: number;
  url?: string;
  active?: boolean;
  title?: string;
  index?: number;
}

interface ChromeTabsQueryInfo {
  active?: boolean;
  lastFocusedWindow?: boolean;
  url?: string | string[];
  windowId?: number;
  currentWindow?: boolean;
  [key: string]: unknown;
}

interface ChromeTabsCreateProperties {
  url?: string;
  active?: boolean;
  windowId?: number;
  index?: number;
}

interface ChromeTabsUpdateProperties {
  url?: string;
  active?: boolean;
  [key: string]: unknown;
}

interface ChromeTabsCaptureVisibleTabOptions {
  format?: 'jpeg' | 'png';
  quality?: number;
}

interface ChromeTabsNamespace {
  query(queryInfo: ChromeTabsQueryInfo): Promise<ChromeTab[]>;
  get(tabId: number): Promise<ChromeTab>;
  create(createProperties: ChromeTabsCreateProperties): Promise<ChromeTab>;
  update(tabId: number, updateProperties: ChromeTabsUpdateProperties): Promise<ChromeTab | undefined>;
  captureVisibleTab(
    windowId: number,
    options?: ChromeTabsCaptureVisibleTabOptions,
  ): Promise<string>;
}

interface ChromeWindowsNamespace {
  readonly WINDOW_ID_CURRENT: number;
  readonly WINDOW_ID_NONE: number;
}

interface ChromeCookie {
  name: string;
  value: string;
  domain: string;
  hostOnly?: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: 'no_restriction' | 'lax' | 'strict' | 'unspecified';
  session?: boolean;
  expirationDate?: number;
  storeId?: string;
}

interface ChromeCookiesGetAllDetails {
  domain?: string;
  name?: string;
  path?: string;
  secure?: boolean;
  session?: boolean;
  storeId?: string;
  url?: string;
}

interface ChromeCookiesSetDetails {
  url: string;
  name?: string;
  value?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'no_restriction' | 'lax' | 'strict' | 'unspecified';
  expirationDate?: number;
  storeId?: string;
}

interface ChromeCookiesNamespace {
  getAll(details: ChromeCookiesGetAllDetails): Promise<ChromeCookie[]>;
  set(details: ChromeCookiesSetDetails): Promise<ChromeCookie | null>;
}

interface ChromeDebuggerDebuggee {
  tabId?: number;
  extensionId?: string;
  targetId?: string;
}

interface ChromeDebuggerNamespace {
  attach(target: ChromeDebuggerDebuggee, requiredVersion: string): Promise<void>;
  detach(target: ChromeDebuggerDebuggee): Promise<void>;
  sendCommand(
    target: ChromeDebuggerDebuggee,
    method: string,
    commandParams?: Record<string, unknown>,
  ): Promise<unknown>;
}

interface ChromeGlobal {
  storage: ChromeStorageNamespace;
  identity: ChromeIdentityNamespace;
  runtime: ChromeRuntimeNamespace;
  tabs: ChromeTabsNamespace;
  windows: ChromeWindowsNamespace;
  cookies: ChromeCookiesNamespace;
  debugger: ChromeDebuggerNamespace;
}

declare const chrome: ChromeGlobal;
