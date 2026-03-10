/**
 * GCP OAuth setup CDP client.
 * Executes API requests through Chrome's CDP (Runtime.evaluate) so requests
 * use the browser's authenticated Google session — no gcloud CLI needed.
 *
 * Two API surfaces are used:
 * 1. clientauthconfig REST API — OAuth client CRUD (create/list clients)
 * 2. OauthEntityService batchGraphql — consent screen / brand / scopes / test users
 */

import {
  createClientUrl,
  GCP_API_KEY,
  listClientsUrl,
  oauthEntityServiceUrl,
  QUERY_SIGNATURES,
  REQUIRED_SCOPE_CODES,
  setApiKey,
} from "./queries.js";
import { loadProjectConfig } from "./session.js";
import type {
  BrandInfo,
  CreateClientRequest,
  GCPOAuthClient,
  ListClientsResponse,
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

/**
 * Find a Chrome tab on console.cloud.google.com and return its WS debugger URL.
 */
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

/**
 * Execute a fetch() call inside Chrome's page context via CDP Runtime.evaluate.
 * The browser handles all cookies, SAPISIDHASH auth headers, and CORS.
 */
async function cdpFetch(
  wsUrl: string,
  url: string,
  opts: { method: string; body?: string; headers?: Record<string, string> },
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = 1;

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("CDP fetch timed out after 30s"));
    }, 30000);

    ws.onopen = () => {
      // GCP APIs require a SAPISIDHASH Authorization header computed from the
      // SAPISID cookie. The browser doesn't add this automatically — the GCP
      // Console JS computes it via SHA-1(timestamp + " " + SAPISID + " " + origin).
      // We compute it inside the page context where we have access to both
      // cookies and the SubtleCrypto API.
      const fetchScript = `
        (async function() {
          // Extract SAPISID from cookies
          var sapisid = (document.cookie.match(/SAPISID=([^;]+)/) || [])[1];
          var headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'X-Goog-AuthUser': '0',
          };

          if (sapisid) {
            var ts = Math.floor(Date.now() / 1000);
            var origin = window.location.origin;
            var input = ts + ' ' + sapisid + ' ' + origin;
            var msgBuf = new TextEncoder().encode(input);
            var hashBuf = await crypto.subtle.digest('SHA-1', msgBuf);
            var hashArr = Array.from(new Uint8Array(hashBuf));
            var hashHex = hashArr.map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
            headers['Authorization'] = 'SAPISIDHASH ' + ts + '_' + hashHex;
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

/**
 * Extract the GCP Console API key from the page context.
 * The key is embedded in script tags and network requests on every Console page.
 */
async function ensureApiKey(): Promise<void> {
  if (GCP_API_KEY) return;

  const wsUrl = await findGcpTab();
  const script = `
    (function() {
      // Try to find the API key from the page's script data
      var scripts = document.querySelectorAll('script');
      for (var i = 0; i < scripts.length; i++) {
        var m = scripts[i].textContent.match(/AIzaSy[A-Za-z0-9_-]{33}/);
        if (m) return m[0];
      }
      return '';
    })()
  `;

  const result = await new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("timeout"));
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
      const msg = JSON.parse(typeof event.data === "string" ? event.data : "");
      if (msg.id === 1) {
        clearTimeout(timeout);
        ws.close();
        resolve(msg.result?.result?.value ?? "");
      }
    };
    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("ws error"));
    };
  });

  if (!result) {
    throw new GCPApiError("Could not extract GCP API key from Console page.");
  }
  setApiKey(result);
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

/**
 * Make a REST API call to clientauthconfig via CDP.
 */
async function restCall<T>(
  url: string,
  method: "GET" | "POST",
  body?: unknown,
): Promise<T> {
  await ensureApiKey();
  const wsUrl = await findGcpTab();
  await throttle();
  const result = await cdpFetch(wsUrl, url, {
    method,
    body: body ? JSON.stringify(body) : undefined,
  });
  return result as T;
}

/**
 * Build the requestContext object for OauthEntityService calls.
 */
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

/**
 * Make a batchGraphql call to OauthEntityService via CDP.
 */
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

  // Response is always an array; extract data from the first result
  const firstResult = result?.[0]?.results?.[0];

  // Check for GraphQL errors
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

  // Response keys are camelCase (e.g. "getBrandInfo" not "GetBrandInfo").
  // Return the raw data object — callers use camelCase keys.
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
// Public API
// ---------------------------------------------------------------------------

// --- OAuth Client CRUD (clientauthconfig REST) ---

export interface CreatedClient {
  clientId: string;
  secret: string;
  displayName: string;
  type: string;
}

/**
 * Create an OAuth client and return the client ID + plaintext secret.
 * The secret is only available at creation time.
 */
export async function createOAuthClient(opts: {
  displayName: string;
  type?: "WEB" | "NATIVE_DESKTOP";
  redirectUris?: string[];
}): Promise<CreatedClient> {
  const { projectNumber } = requireConfig();

  const body: CreateClientRequest = {
    type: opts.type ?? "WEB",
    displayName: opts.displayName,
    redirectUris: opts.redirectUris ?? [],
    authType: "SHARED_SECRET",
    brandId: projectNumber,
    projectNumber,
  };

  const result = await restCall<GCPOAuthClient>(
    createClientUrl(),
    "POST",
    body,
  );

  const secret = result.clientSecrets?.[0]?.clientSecret;
  if (!secret) {
    throw new GCPApiError(
      "Client created but no secret returned. This is unexpected.",
    );
  }

  return {
    clientId: result.clientId,
    secret: secret,
    displayName: result.displayName,
    type: result.type,
  };
}

/**
 * List all OAuth clients for the configured project.
 */
export async function listOAuthClients(): Promise<GCPOAuthClient[]> {
  const { projectNumber } = requireConfig();
  const result = await restCall<ListClientsResponse>(
    listClientsUrl(projectNumber),
    "GET",
  );
  return result.clients ?? [];
}

// --- Consent Screen / Brand (OauthEntityService) ---

/**
 * Get current brand/consent screen configuration.
 */
export async function getBrandInfo(): Promise<BrandInfo> {
  const { projectId, projectNumber } = requireConfig();
  const data = await oauthGraphql<{ getBrandInfo: BrandInfo }>(
    "GetBrandInfo",
    { projectNumber },
    projectId,
  );
  return data.getBrandInfo;
}

/**
 * Check if the consent screen / brand is already configured.
 */
export async function isBrandConfigured(): Promise<boolean> {
  const info = await getBrandInfo();
  return info.isBrandConfigured;
}

/**
 * Update scopes on the consent screen.
 * Uses scope codes (numeric IDs) that map to OAuth scope URLs.
 */
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
    // The operation is async. Wait and verify via getBrandInfo instead of
    // polling (we don't have the GetOperation query signature).
    // Scopes appear under brandPolicy.unreviewedConfig.scopes (not brandPolicy.scopes).
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

/**
 * Set the list of test users for the OAuth consent screen.
 */
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

/**
 * Get the current list of test users.
 */
export async function getTestUsers(): Promise<string[]> {
  const { projectId, projectNumber } = requireConfig();
  const data = await oauthGraphql<{
    getTrustedUserList: TrustedUserList;
  }>("GetTrustedUserList", { projectNumber }, projectId, "/auth/audience");
  const accounts = data.getTrustedUserList?.userAccount ?? [];
  // userAccount can be string[] or {email: string}[] depending on API version
  return accounts.map((u: unknown) =>
    typeof u === "string" ? u : (u as { email: string }).email,
  );
}

/**
 * List OAuth client IDs via the OauthEntityService (lighter than REST list).
 */
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

// --- Convenience: full setup flow ---

export interface SetupResult {
  clientId: string;
  secret: string;
  brandConfigured: boolean;
  scopesSet: boolean;
  testUsersSet: boolean;
}

/**
 * Run the full automated OAuth setup:
 * 1. Check/configure brand (consent screen)
 * 2. Set required scopes
 * 3. Add test user
 * 4. Create OAuth client
 * 5. Return client ID + secret
 */
export async function fullSetup(opts: {
  userEmail: string;
  clientName?: string;
  clientType?: "WEB" | "NATIVE_DESKTOP";
  redirectUris?: string[];
}): Promise<SetupResult> {
  const result: SetupResult = {
    clientId: "",
    secret: "",
    brandConfigured: false,
    scopesSet: false,
    testUsersSet: false,
  };

  // 1. Check brand
  const brandConfigured = await isBrandConfigured();
  result.brandConfigured = brandConfigured;
  if (!brandConfigured) {
    process.stderr.write(
      "[gcp-oauth] Brand not configured — consent screen setup needed via browser\n",
    );
  }

  // 2. Set scopes
  try {
    await updateScopes();
    result.scopesSet = true;
    process.stderr.write("[gcp-oauth] Scopes configured\n");
  } catch (err) {
    process.stderr.write(
      `[gcp-oauth] Failed to set scopes: ${err instanceof Error ? err.message : err}\n`,
    );
  }

  // 3. Add test user
  try {
    await setTestUsers([opts.userEmail]);
    result.testUsersSet = true;
    process.stderr.write(`[gcp-oauth] Test user added: ${opts.userEmail}\n`);
  } catch (err) {
    process.stderr.write(
      `[gcp-oauth] Failed to add test user: ${err instanceof Error ? err.message : err}\n`,
    );
  }

  // 4. Create client
  const client = await createOAuthClient({
    displayName: opts.clientName ?? "Vellum Assistant",
    type: opts.clientType,
    redirectUris: opts.redirectUris,
  });
  result.clientId = client.clientId;
  result.secret = client.secret;
  process.stderr.write(
    `[gcp-oauth] OAuth client created: ${client.clientId}\n`,
  );

  return result;
}

export { REQUIRED_SCOPE_CODES } from "./queries.js";
