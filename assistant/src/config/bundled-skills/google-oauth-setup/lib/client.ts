/**
 * GCP OAuth consent screen API client.
 *
 * Executes requests through Chrome's CDP (Runtime.evaluate) so requests use
 * the browser's authenticated Google session. Only includes functions that
 * work via the cloudconsole-pa GraphQL proxy (SAPISIDHASH auth).
 *
 * Functions for project management, API enablement, and OAuth client CRUD
 * are NOT included — those endpoints (clientauthconfig, serviceusage,
 * cloudresourcemanager) return 403 with SAPISIDHASH and must be done via
 * browser automation.
 */

import {
  GCP_API_KEY,
  oauthEntityServiceUrl,
  QUERY_SIGNATURES,
  REQUIRED_SCOPE_CODES,
  setApiKey,
} from "./queries.js";
import { loadProjectConfig } from "./session.js";
import type {
  BrandInfo,
  RequestContext,
  TrustedUserList,
  UpdateBrandInfoResult,
} from "./types.js";

const CDP_BASE = "http://localhost:9222";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SessionExpiredError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SessionExpiredError";
  }
}

export class GCPApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "GCPApiError";
  }
}

// ---------------------------------------------------------------------------
// CDP transport
// ---------------------------------------------------------------------------

async function findGcpTab(): Promise<string> {
  const res = await fetch(`${CDP_BASE}/json/list`).catch(() => null);
  if (!res?.ok) {
    throw new SessionExpiredError(
      "Chrome CDP not available. Make sure Chrome is running with --remote-debugging-port=9222.",
    );
  }
  const targets = (await res.json()) as Array<{
    type: string;
    url: string;
    webSocketDebuggerUrl: string;
  }>;
  const gcpTab = targets.find(
    (t) => t.type === "page" && t.url.includes("console.cloud.google.com"),
  );
  const tab = gcpTab ?? targets.find((t) => t.type === "page");
  if (!tab?.webSocketDebuggerUrl) {
    throw new SessionExpiredError(
      "No Chrome tab available. Open console.cloud.google.com in Chrome first.",
    );
  }
  return tab.webSocketDebuggerUrl;
}

async function cdpFetch(
  wsUrl: string,
  url: string,
  opts: { method: string; body?: string },
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = 1;

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("CDP fetch timed out after 30s"));
    }, 30000);

    ws.onopen = () => {
      const fetchScript = `
        (async function() {
          var sapisid = (document.cookie.match(/SAPISID=([^;]+)/) || [])[1];
          var headers = {
            'Accept': 'application/json, text/plain, */*',
            'X-Goog-AuthUser': '0',
          };
          ${opts.body ? `headers['Content-Type'] = 'application/json';` : ""}

          if (sapisid) {
            var ts = Math.floor(Date.now() / 1000);
            var origin = window.location.origin;
            var input = ts + ' ' + sapisid + ' ' + origin;
            var msgBuf = new TextEncoder().encode(input);
            var hashBuf = await crypto.subtle.digest('SHA-1', msgBuf);
            var hashArr = Array.from(new Uint8Array(hashBuf));
            var hashHex = hashArr.map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
            var hash = 'SAPISIDHASH ' + ts + '_' + hashHex
                     + ' SAPISID1PHASH ' + ts + '_' + hashHex
                     + ' SAPISID3PHASH ' + ts + '_' + hashHex;
            headers['Authorization'] = hash;
          }

          return fetch(${JSON.stringify(url)}, {
            method: ${JSON.stringify(opts.method)},
            headers: headers,
            ${opts.body ? `body: ${JSON.stringify(opts.body)},` : ""}
            credentials: 'include',
          })
          .then(function(r) {
            if (!r.ok) return r.text().then(function(t) {
              return JSON.stringify({ __status: r.status, __error: true, __body: t.substring(0, 2000) });
            });
            return r.text();
          })
          .catch(function(e) { return JSON.stringify({ __error: true, __message: e.message }); });
        })()
      `;

      ws.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: {
            expression: fetchScript,
            awaitPromise: true,
            returnByValue: true,
          },
        }),
      );
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(
          typeof event.data === "string" ? event.data : "",
        );
        if (msg.id === id) {
          clearTimeout(timeout);
          ws.close();

          if (msg.error) {
            reject(new Error(`CDP error: ${msg.error.message}`));
            return;
          }

          const value = msg.result?.result?.value;
          if (!value) {
            reject(new Error("Empty CDP response"));
            return;
          }

          const parsed = typeof value === "string" ? JSON.parse(value) : value;
          if (parsed.__error) {
            if (parsed.__status === 401 || parsed.__status === 403) {
              reject(
                new SessionExpiredError(
                  `GCP session expired or unauthorized (HTTP ${parsed.__status}).`,
                ),
              );
            } else {
              reject(
                new GCPApiError(
                  parsed.__message ??
                    `HTTP ${parsed.__status}: ${parsed.__body ?? ""}`,
                  parsed.__status,
                ),
              );
            }
            return;
          }
          resolve(parsed);
        }
      } catch (err) {
        clearTimeout(timeout);
        ws.close();
        reject(err);
      }
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new SessionExpiredError("CDP connection failed."));
    };
  });
}

// ---------------------------------------------------------------------------
// API key extraction
// ---------------------------------------------------------------------------

async function ensureApiKey(): Promise<void> {
  if (GCP_API_KEY) return;

  const wsUrl = await findGcpTab();

  // Strategy 1: Check Resource Timing API for past requests
  const keyFromTiming = await extractApiKeyFromResourceTiming(wsUrl);
  if (keyFromTiming) {
    setApiKey(keyFromTiming);
    return;
  }

  // Strategy 2: Script-tag scraping (fallback)
  const keyFromScripts = await extractApiKeyFromScripts(wsUrl);
  if (keyFromScripts) {
    setApiKey(keyFromScripts);
    return;
  }

  throw new GCPApiError("Could not extract GCP API key from Console page.");
}

async function extractApiKeyFromResourceTiming(
  wsUrl: string,
): Promise<string | null> {
  const script = `
    (function() {
      var entries = performance.getEntriesByType('resource');
      for (var i = entries.length - 1; i >= 0; i--) {
        var url = entries[i].name;
        if (url.indexOf('clients6.google.com') !== -1 ||
            url.indexOf('cloudconsole-pa') !== -1) {
          var m = url.match(/[?&]key=(AIzaSy[A-Za-z0-9_-]{33})/);
          if (m) return m[1];
        }
      }
      return '';
    })()
  `;

  return new Promise<string | null>((resolve) => {
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => {
      ws.close();
      resolve(null);
    }, 5000);
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression: script, returnByValue: true },
        }),
      );
    };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(
          typeof event.data === "string" ? event.data : "",
        );
        if (msg.id === 1) {
          clearTimeout(timeout);
          ws.close();
          resolve(msg.result?.result?.value || null);
        }
      } catch {
        // ignore
      }
    };
    ws.onerror = () => {
      clearTimeout(timeout);
      resolve(null);
    };
  });
}

async function extractApiKeyFromScripts(wsUrl: string): Promise<string | null> {
  const script = `
    (function() {
      var scripts = document.querySelectorAll('script');
      for (var i = 0; i < scripts.length; i++) {
        var m = scripts[i].textContent.match(/AIzaSy[A-Za-z0-9_-]{33}/);
        if (m) return m[0];
      }
      return '';
    })()
  `;

  return new Promise<string | null>((resolve) => {
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => {
      ws.close();
      resolve(null);
    }, 10000);
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression: script, returnByValue: true },
        }),
      );
    };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(
          typeof event.data === "string" ? event.data : "",
        );
        if (msg.id === 1) {
          clearTimeout(timeout);
          ws.close();
          resolve(msg.result?.result?.value || null);
        }
      } catch {
        clearTimeout(timeout);
        ws.close();
        resolve(null);
      }
    };
    ws.onerror = () => {
      clearTimeout(timeout);
      resolve(null);
    };
  });
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

let lastRequestTime = 0;

async function throttle(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (lastRequestTime > 0 && elapsed < 500) {
    await new Promise((r) => setTimeout(r, 500 - elapsed));
  }
  lastRequestTime = Date.now();
}

function buildRequestContext(
  projectId: string,
  pagePath = "/auth/branding",
): RequestContext {
  return {
    platformMetadata: { platformType: "RIF" },
    p2Metadata: {
      feature: "features/1691453455344",
      environment: "environments/production",
      release: "releases/boq_cloud-boq-clientweb-oauth_20260223.04_p0",
      extension: "extensions/oauth",
    },
    clientVersion: "pantheon.pangular_20260302.09_p0",
    pagePath,
    projectId,
    selectedPurview: { projectId },
    jurisdiction: "global",
    localizationData: {
      locale: "en_US",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  };
}

async function oauthGraphql<T>(
  operationName: string,
  variables: Record<string, unknown>,
  projectId: string,
  pagePath?: string,
): Promise<T> {
  const signature =
    QUERY_SIGNATURES[operationName as keyof typeof QUERY_SIGNATURES];
  if (!signature) {
    throw new Error(`Unknown query signature for operation: ${operationName}`);
  }

  await ensureApiKey();
  const wsUrl = await findGcpTab();
  await throttle();

  const body = JSON.stringify({
    requestContext: buildRequestContext(projectId, pagePath),
    querySignature: signature,
    operationName,
    variables,
  });

  const result = (await cdpFetch(wsUrl, oauthEntityServiceUrl(), {
    method: "POST",
    body,
  })) as Array<{
    results: Array<{
      data: Record<string, unknown> | null;
      errors?: Array<{ message: string; errorType?: string }>;
      path: unknown[];
    }>;
  }>;

  const firstResult = result?.[0]?.results?.[0];

  if (firstResult?.errors?.length) {
    const msgs = firstResult.errors.map((e) => e.message).join("; ");
    throw new GCPApiError(`${operationName} failed: ${msgs}`);
  }

  const data = firstResult?.data;
  if (!data) {
    throw new GCPApiError(
      `Empty response from ${operationName}: ${JSON.stringify(result).slice(0, 500)}`,
    );
  }

  return data as T;
}

// ---------------------------------------------------------------------------
// Config helper
// ---------------------------------------------------------------------------

function requireConfig(): { projectId: string; projectNumber: string } {
  const config = loadProjectConfig();
  if (!config) {
    throw new GCPApiError(
      "No GCP project configured. Run setup first to set project ID and number.",
    );
  }
  return config;
}

// ---------------------------------------------------------------------------
// Public API — consent screen / brand operations
// ---------------------------------------------------------------------------

export async function getBrandInfo(): Promise<BrandInfo> {
  const { projectId, projectNumber } = requireConfig();
  const data = await oauthGraphql<{ getBrandInfo: BrandInfo }>(
    "GetBrandInfo",
    { projectNumber },
    projectId,
  );
  return data.getBrandInfo;
}

export async function isBrandConfigured(): Promise<boolean> {
  const info = await getBrandInfo();
  return info.isBrandConfigured;
}

export async function updateScopes(
  scopeCodes?: number[],
): Promise<UpdateBrandInfoResult> {
  const { projectId, projectNumber } = requireConfig();
  const codes = scopeCodes ?? REQUIRED_SCOPE_CODES;

  const data = await oauthGraphql<{
    updateBrandInfo: UpdateBrandInfoResult;
  }>(
    "UpdateBrandInfo",
    {
      request: {
        projectNumber,
        updateBrandPolicyRequest: {
          scopes: {
            operationType: "SET",
            values: codes,
          },
          projectNumber,
        },
        isPendingVerification: false,
      },
    },
    projectId,
    "/auth/scopes",
  );

  const op = data.updateBrandInfo;
  if (op.name && !op.done) {
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const brand = await getBrandInfo();
      const unreviewedScopes = (brand.brandPolicy as Record<string, unknown>)
        ?.unreviewedConfig as { scopes?: number[] } | undefined;
      if (unreviewedScopes?.scopes && unreviewedScopes.scopes.length > 0) {
        return op;
      }
    }
    process.stderr.write(
      "[gcp-oauth] Scope update operation started but verification timed out\n",
    );
  }
  return op;
}

export async function setTestUsers(emails: string[]): Promise<TrustedUserList> {
  const { projectId, projectNumber } = requireConfig();
  const data = await oauthGraphql<{
    setTrustedUserList: { trustedUserList: TrustedUserList };
  }>(
    "SetTrustedUserList",
    { projectNumber, trustedUserList: emails },
    projectId,
    "/auth/audience",
  );
  return data.setTrustedUserList.trustedUserList;
}

export async function getTestUsers(): Promise<string[]> {
  const { projectId, projectNumber } = requireConfig();
  const data = await oauthGraphql<{
    getTrustedUserList: TrustedUserList;
  }>("GetTrustedUserList", { projectNumber }, projectId, "/auth/audience");
  const accounts = data.getTrustedUserList?.userAccount ?? [];
  return accounts.map((u: unknown) =>
    typeof u === "string" ? u : (u as { email: string }).email,
  );
}

export async function listClientIds(): Promise<
  Array<{ clientId: string; displayName: string }>
> {
  const { projectId, projectNumber } = requireConfig();
  const data = await oauthGraphql<{
    listClientIds: {
      clients: Array<{ clientId: string; displayName: string }>;
    };
  }>("ListClientIds", { projectNumber }, projectId, "/auth/clients");
  return data.listClientIds?.clients ?? [];
}

export { REQUIRED_SCOPE_CODES } from "./queries.js";
