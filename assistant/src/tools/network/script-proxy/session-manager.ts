import { join } from "node:path";

import {
  createSession as coreCreateSession,
  getActiveSession as coreGetActiveSession,
  getOrStartSession as coreGetOrStartSession,
  getSessionEnv as coreGetSessionEnv,
  getSessionsForConversation as coreGetSessionsForConversation,
  type ManagedSession,
  type PolicyCallback,
  type ProxyApprovalCallback,
  type ProxyEnvVars,
  type ProxySession,
  type ProxySessionConfig,
  type ProxySessionId,
  type SessionStartHooks,
  SessionStore,
  startSession as coreStartSession,
  stopAllSessions as coreStopAllSessions,
  stopSession as coreStopSession,
} from "@vellumai/egress-proxy";

import {
  buildDecisionTrace,
  createProxyServer,
  ensureCombinedCABundle,
  ensureLocalCA,
  evaluateRequestWithApproval,
  getCAPath,
  type ProxyServerConfig,
  routeConnection,
  stripQueryString,
} from "../../../outbound-proxy/index.js";
import { getSecureKeyAsync } from "../../../security/secure-keys.js";
import { getLogger } from "../../../util/logger.js";
import {
  compareMatchSpecificity,
  type HostMatchKind,
  matchHostPattern,
} from "../../credentials/host-pattern-match.js";
import { listCredentialMetadata } from "../../credentials/metadata-store.js";
import type { CredentialInjectionTemplate } from "../../credentials/policy-types.js";
import {
  resolveById,
  resolveByServiceField,
  type ResolvedCredential,
} from "../../credentials/resolve.js";

const log = getLogger("proxy-session");

// ---------------------------------------------------------------------------
// Shared session store (singleton for the assistant process)
// ---------------------------------------------------------------------------

const store = new SessionStore();

// ---------------------------------------------------------------------------
// Allowed host patterns
// ---------------------------------------------------------------------------

/**
 * Host patterns that are allowed by default through the proxy policy engine,
 * regardless of session configuration. Supports exact matches (e.g.
 * `"localhost"`) and wildcard subdomain patterns (e.g. `"*.vellum.ai"`
 * matches `platform.vellum.ai`, `dev-platform.vellum.ai`, etc.).
 */
const ALLOWED_HOST_PATTERNS: readonly string[] = ["*.vellum.ai", "localhost"];

/**
 * Returns `true` when `hostname` matches any entry in
 * {@link ALLOWED_HOST_PATTERNS}.
 */
function isAllowedHost(hostname: string): boolean {
  for (const pattern of ALLOWED_HOST_PATTERNS) {
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1); // e.g. ".vellum.ai"
      if (hostname.endsWith(suffix) || hostname === pattern.slice(2)) {
        return true;
      }
    } else if (hostname === pattern) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Credential helpers
// ---------------------------------------------------------------------------

/**
 * Build the final header value for a matched credential injection template.
 * Handles optional composition with a second credential and value transforms.
 * Returns null if any referenced credential cannot be resolved.
 */
async function buildInjectedValue(
  tpl: CredentialInjectionTemplate,
  primaryValue: string,
): Promise<string | null> {
  let value = primaryValue;

  if (tpl.composeWith) {
    const composed = resolveByServiceField(
      tpl.composeWith.service,
      tpl.composeWith.field,
    );
    if (!composed) return null;
    const composedValue = await getSecureKeyAsync(composed.storageKey);
    if (!composedValue) return null;
    value = `${value}${tpl.composeWith.separator}${composedValue}`;
  }

  if (tpl.valueTransform === "base64") {
    value = Buffer.from(value).toString("base64");
  }

  return (tpl.valuePrefix ?? "") + value;
}

/**
 * Resolve injection templates for a credential.
 */
function resolveInjectionTemplates(
  resolved: ResolvedCredential | undefined,
): CredentialInjectionTemplate[] {
  if (!resolved) return [];
  return resolved.injectionTemplates;
}

// ---------------------------------------------------------------------------
// Session start hooks — wires assistant credential resolution into core
// ---------------------------------------------------------------------------

function buildSessionStartHooks(): SessionStartHooks {
  return {
    setupCA: async (managed: ManagedSession) => {
      if (!managed.dataDir || managed.session.credentialIds.length === 0) {
        return;
      }

      // Build templates to check if MITM is needed
      const templates = new Map<string, CredentialInjectionTemplate[]>();
      for (const credId of managed.session.credentialIds) {
        const resolved = resolveById(credId);
        const injectionTemplates = resolveInjectionTemplates(resolved);
        if (injectionTemplates.length > 0) {
          templates.set(credId, injectionTemplates);
        }
      }

      if (templates.size > 0) {
        await ensureLocalCA(managed.dataDir);
        managed.combinedCABundlePath = await ensureCombinedCABundle(
          managed.dataDir,
        );
      }
    },

    createServer: async (managed: ManagedSession) => {
      const config: ProxyServerConfig = {};

      // Build a templates map from credential metadata
      const templates = new Map<string, CredentialInjectionTemplate[]>();
      for (const credId of managed.session.credentialIds) {
        const resolved = resolveById(credId);
        const injectionTemplates = resolveInjectionTemplates(resolved);
        if (injectionTemplates.length > 0) {
          templates.set(credId, injectionTemplates);
        }
      }

      if (
        managed.dataDir &&
        managed.session.credentialIds.length > 0 &&
        templates.size > 0
      ) {
        const caDir = join(managed.dataDir, "proxy-ca");

        config.mitmHandler = {
          caDir,
          shouldIntercept: (hostname: string, port: number) =>
            routeConnection(
              hostname,
              port,
              managed.session.credentialIds,
              templates,
            ),
          rewriteCallback: async (req) => {
            // Per-credential best-match selection, mirroring the policy engine's
            // specificity logic
            const perCredentialBest: {
              credId: string;
              tpl: CredentialInjectionTemplate;
            }[] = [];

            for (const [credId, tpls] of templates) {
              let bestMatch: HostMatchKind = "none";
              let bestCandidates: CredentialInjectionTemplate[] = [];

              for (const tpl of tpls) {
                if (tpl.injectionType === "query") continue;
                const match = matchHostPattern(req.hostname, tpl.hostPattern, {
                  includeApexForWildcard: true,
                });
                if (match === "none") continue;

                const cmp = compareMatchSpecificity(match, bestMatch);
                if (cmp < 0) {
                  bestMatch = match;
                  bestCandidates = [tpl];
                } else if (cmp === 0) {
                  bestCandidates.push(tpl);
                }
              }

              if (bestCandidates.length === 1) {
                perCredentialBest.push({ credId, tpl: bestCandidates[0] });
              } else if (bestCandidates.length > 1) {
                // Same credential, same-specificity tie — ambiguous, block
                return null;
              }
            }

            if (perCredentialBest.length === 0) return req.headers;
            // Cross-credential ambiguity — block
            if (perCredentialBest.length > 1) return null;

            const { credId, tpl } = perCredentialBest[0];
            log.debug(
              {
                host: req.hostname,
                pattern: tpl.hostPattern,
                credentialId: credId,
              },
              "MITM rewrite: injecting credential",
            );

            if (tpl.injectionType === "header" && tpl.headerName) {
              const resolved = resolveById(credId);
              if (!resolved) return req.headers;
              const value = await getSecureKeyAsync(resolved.storageKey);
              if (!value) return req.headers;

              const headerValue = await buildInjectedValue(tpl, value);
              if (!headerValue) {
                log.warn(
                  { host: req.hostname, credentialId: credId },
                  "MITM rewrite: blocking request — composeWith credential missing",
                );
                return null;
              }
              req.headers[tpl.headerName.toLowerCase()] = headerValue;
              return req.headers;
            }

            return req.headers;
          },
        };
      }

      // Cache the full credential registry with a TTL
      let allKnownCache: CredentialInjectionTemplate[] | null = null;
      let allKnownCacheTime = 0;
      const CACHE_TTL_MS = 30_000; // 30 seconds

      function getAllKnown(): CredentialInjectionTemplate[] {
        const now = Date.now();
        if (!allKnownCache || now - allKnownCacheTime > CACHE_TTL_MS) {
          allKnownCache = [];
          for (const meta of listCredentialMetadata()) {
            if (meta.injectionTemplates?.length) {
              allKnownCache.push(...meta.injectionTemplates);
            }
          }
          allKnownCacheTime = now;
        }
        return allKnownCache;
      }

      // Build the policy callback for HTTP/CONNECT request gating
      const policyCallback: PolicyCallback = async (
        hostname: string,
        port: number | null,
        reqPath: string,
        scheme: "http" | "https",
      ) => {
        if (isAllowedHost(hostname)) {
          log.debug({ hostname }, "Allowing always-permitted host");
          return {};
        }

        const decision = evaluateRequestWithApproval(
          hostname,
          port,
          reqPath,
          managed.session.credentialIds,
          templates,
          getAllKnown(),
          scheme,
        );

        log.debug(
          {
            trace: buildDecisionTrace(
              hostname,
              port,
              stripQueryString(reqPath),
              scheme,
              decision,
            ),
          },
          "Policy decision",
        );

        switch (decision.kind) {
          case "matched": {
            const { credentialId, template } = decision;
            const resolved = resolveById(credentialId);
            if (!resolved) return {};
            const value = await getSecureKeyAsync(resolved.storageKey);
            if (!value) return {};

            if (template.injectionType === "header" && template.headerName) {
              const headerValue = await buildInjectedValue(template, value);
              if (!headerValue) {
                log.warn(
                  { hostname, credentialId },
                  "Policy: blocking matched request — composeWith credential missing",
                );
                return null;
              }
              return { [template.headerName.toLowerCase()]: headerValue };
            }
            return {};
          }
          case "ambiguous":
            return null; // block — can't auto-resolve
          case "ask_missing_credential":
          case "ask_unauthenticated":
            if (managed.approvalCallback) {
              const approved = await managed.approvalCallback({
                decision,
                sessionId: managed.session.id,
              });
              return approved ? {} : null;
            }
            return decision.kind === "ask_unauthenticated" ? {} : null;
          case "missing":
            return null;
          case "unauthenticated":
            return {};
          default:
            return null;
        }
      };

      config.policyCallback = policyCallback;

      return createProxyServer(config);
    },

    getCAPath: (dataDir: string) => getCAPath(dataDir),
  };
}

// ---------------------------------------------------------------------------
// Public API — thin wrappers that delegate to session-core with the store
// ---------------------------------------------------------------------------

/**
 * Create a new proxy session bound to a conversation.
 * The session starts in 'starting' status with no port assigned yet.
 */
export function createSession(
  conversationId: string,
  credentialIds: string[],
  config?: Partial<ProxySessionConfig>,
  dataDir?: string,
  approvalCallback?: ProxyApprovalCallback,
): ProxySession {
  return coreCreateSession(
    store,
    conversationId,
    credentialIds,
    config,
    dataDir,
    approvalCallback,
  );
}

/**
 * Start the proxy session — opens an HTTP server on an ephemeral port.
 */
export async function startSession(
  sessionId: ProxySessionId,
  options?: { listenHost?: string },
): Promise<ProxySession> {
  return coreStartSession(store, sessionId, buildSessionStartHooks(), options);
}

/**
 * Gracefully stop a session — closes the HTTP server and clears the idle timer.
 */
export async function stopSession(sessionId: ProxySessionId): Promise<void> {
  return coreStopSession(sessionId, store);
}

/**
 * Build environment variables to inject into a subprocess so its HTTP
 * traffic flows through this proxy session.
 */
export function getSessionEnv(sessionId: ProxySessionId): ProxyEnvVars {
  return coreGetSessionEnv(store, sessionId, buildSessionStartHooks());
}

/**
 * Atomically acquire a proxy session for a conversation — reuses an active
 * session or creates + starts a new one.
 */
export async function getOrStartSession(
  conversationId: string,
  credentialIds: string[],
  config?: Partial<ProxySessionConfig>,
  dataDir?: string,
  approvalCallback?: ProxyApprovalCallback,
  options?: { listenHost?: string },
): Promise<{ session: ProxySession; created: boolean }> {
  return coreGetOrStartSession(
    store,
    conversationId,
    credentialIds,
    buildSessionStartHooks(),
    config,
    dataDir,
    approvalCallback,
    options,
  );
}

/**
 * Find an active session for a conversation (returns the first match).
 */
export function getActiveSession(
  conversationId: string,
): ProxySession | undefined {
  return coreGetActiveSession(store, conversationId);
}

/**
 * Get all sessions for a given conversation.
 */
export function getSessionsForConversation(
  conversationId: string,
): ProxySession[] {
  return coreGetSessionsForConversation(store, conversationId);
}

/**
 * Stop all sessions and clear internal state. Useful for daemon shutdown.
 */
export async function stopAllSessions(): Promise<void> {
  return coreStopAllSessions(store, (id, err) => {
    log.debug({ err, id }, "session shutdown error");
  });
}
