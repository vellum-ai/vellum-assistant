/**
 * Route policy enforcement for the runtime HTTP server.
 *
 * Each protected endpoint declares the scopes and principal types it
 * requires. `enforcePolicy` checks the AuthContext against these
 * requirements and returns an error Response when access is denied.
 *
 * When auth is bypassed in dev mode, policies are still evaluated for
 * type safety but always allow the request through.
 */

import { isHttpAuthDisabled } from "../../config/env.js";
import { getLogger } from "../../util/logger.js";
import type { AuthContext, PrincipalType, Scope } from "./types.js";

const log = getLogger("route-policy");

// ---------------------------------------------------------------------------
// Policy definition
// ---------------------------------------------------------------------------

export interface RoutePolicy {
  requiredScopes: Scope[];
  allowedPrincipalTypes: PrincipalType[];
}

// ---------------------------------------------------------------------------
// Policy registry
// ---------------------------------------------------------------------------

const policyRegistry = new Map<string, RoutePolicy>();

/**
 * Register a route policy. Called at module load time to populate the
 * registry with all protected endpoint policies.
 */
function registerPolicy(endpoint: string, policy: RoutePolicy): void {
  policyRegistry.set(endpoint, policy);
}

/**
 * Look up the policy for an endpoint. Returns undefined for unregistered
 * (unprotected) endpoints.
 */
export function getPolicy(endpoint: string): RoutePolicy | undefined {
  return policyRegistry.get(endpoint);
}

// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------

/**
 * Enforce the route policy for the given endpoint against the AuthContext.
 *
 * Returns an error Response if the request should be denied, or null if
 * the request is allowed to proceed.
 *
 * When auth is bypassed (dev mode), the policy is still checked against
 * the synthetic context for type safety but always returns null (allowed).
 */
export function enforcePolicy(
  endpoint: string,
  authCtx: AuthContext,
): Response | null {
  const policy = policyRegistry.get(endpoint);
  if (!policy) {
    // No policy registered — unprotected endpoint (e.g. health, debug)
    return null;
  }

  // Dev bypass: log but allow everything through
  if (isHttpAuthDisabled()) {
    return null;
  }

  // Check principal type
  if (!policy.allowedPrincipalTypes.includes(authCtx.principalType)) {
    log.warn(
      {
        endpoint,
        principalType: authCtx.principalType,
        allowed: policy.allowedPrincipalTypes,
      },
      "Route policy denied: principal type not allowed",
    );
    return Response.json(
      {
        error: {
          code: "FORBIDDEN",
          message: "Principal type not permitted for this endpoint",
        },
      },
      { status: 403 },
    );
  }

  // Check required scopes
  for (const scope of policy.requiredScopes) {
    if (!authCtx.scopes.has(scope)) {
      log.warn(
        { endpoint, missingScope: scope, principalType: authCtx.principalType },
        "Route policy denied: missing required scope",
      );
      return Response.json(
        {
          error: {
            code: "FORBIDDEN",
            message: `Missing required scope: ${scope}`,
          },
        },
        { status: 403 },
      );
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Policy registrations for all protected routes
// ---------------------------------------------------------------------------

// Standard actor endpoints — chat, approvals, settings, etc.
const ACTOR_ENDPOINTS: Array<{ endpoint: string; scopes: Scope[] }> = [
  // Conversation / messaging
  { endpoint: "messages:GET", scopes: ["chat.read"] },
  { endpoint: "messages:POST", scopes: ["chat.write"] },
  { endpoint: "btw", scopes: ["chat.write"] },
  { endpoint: "conversations", scopes: ["chat.read"] },
  { endpoint: "conversations:POST", scopes: ["chat.write"] },
  { endpoint: "conversations/fork", scopes: ["chat.write"] },
  { endpoint: "conversations/analyze", scopes: ["chat.write"] },
  { endpoint: "conversations/switch", scopes: ["chat.write"] },
  { endpoint: "conversations/name", scopes: ["chat.write"] },
  { endpoint: "conversations/rename", scopes: ["chat.write"] },
  { endpoint: "conversations/wake", scopes: ["chat.write"] },

  { endpoint: "conversations/inference-profile", scopes: ["chat.write"] },
  { endpoint: "conversations/cancel", scopes: ["chat.write"] },
  { endpoint: "conversations/undo", scopes: ["chat.write"] },
  { endpoint: "conversations/regenerate", scopes: ["chat.write"] },
  { endpoint: "conversations/attention", scopes: ["chat.read"] },
  { endpoint: "conversations/seen", scopes: ["chat.write"] },
  { endpoint: "conversations/unread", scopes: ["chat.write"] },
  { endpoint: "search", scopes: ["chat.read"] },
  { endpoint: "search/global", scopes: ["chat.read"] },
  { endpoint: "suggestion", scopes: ["chat.read"] },

  // Approvals
  { endpoint: "confirm", scopes: ["approval.write"] },
  { endpoint: "secret", scopes: ["approval.write"] },
  { endpoint: "trust-rules", scopes: ["approval.write"] },
  { endpoint: "host-app-control-result", scopes: ["approval.write"] },
  { endpoint: "host-bash-result", scopes: ["approval.write"] },
  { endpoint: "host-browser-result", scopes: ["approval.write"] },
  { endpoint: "host-browser-event", scopes: ["approval.write"] },
  { endpoint: "host-browser-session-invalidated", scopes: ["approval.write"] },
  { endpoint: "host-cu-result", scopes: ["approval.write"] },
  { endpoint: "host-file-result", scopes: ["approval.write"] },
  { endpoint: "host-transfer-result", scopes: ["approval.write"] },
  { endpoint: "transfers/content", scopes: ["approval.write"] },
  { endpoint: "pending-interactions", scopes: ["approval.read"] },

  // Guardian actions
  { endpoint: "guardian-actions/pending", scopes: ["approval.read"] },
  { endpoint: "guardian-actions/decision", scopes: ["approval.write"] },

  // Events (SSE)
  { endpoint: "events", scopes: ["chat.read"] },

  // Trace events
  { endpoint: "trace-events", scopes: ["chat.read"] },

  // Attachments
  { endpoint: "attachments:POST", scopes: ["attachments.write"] },
  { endpoint: "attachments:DELETE", scopes: ["attachments.write"] },
  { endpoint: "attachments:GET", scopes: ["attachments.read"] },
  { endpoint: "attachments/content:GET", scopes: ["attachments.read"] },

  // Calls
  { endpoint: "calls/start", scopes: ["calls.write"] },
  { endpoint: "calls:GET", scopes: ["calls.read"] },
  { endpoint: "calls/cancel", scopes: ["calls.write"] },
  { endpoint: "calls/answer", scopes: ["calls.write"] },
  { endpoint: "calls/instruction", scopes: ["calls.write"] },

  // Settings / integrations / identity
  { endpoint: "ps", scopes: ["settings.read"] },
  { endpoint: "identity", scopes: ["settings.read"] },
  { endpoint: "identity/intro", scopes: ["settings.read"] },
  { endpoint: "home/state", scopes: ["settings.read"] },
  { endpoint: "home/feed", scopes: ["settings.read"] },
  { endpoint: "home/feed:PATCH", scopes: ["settings.write"] },
  { endpoint: "home/feed/actions", scopes: ["settings.write"] },
  { endpoint: "brain-graph", scopes: ["settings.read"] },
  { endpoint: "brain-graph-ui", scopes: ["settings.read"] },
  { endpoint: "contacts", scopes: ["settings.read"] },
  { endpoint: "contacts:POST", scopes: ["settings.write"] },
  { endpoint: "contacts:DELETE", scopes: ["settings.write"] },
  { endpoint: "contacts/merge", scopes: ["settings.write"] },
  { endpoint: "contacts/search", scopes: ["settings.read"] },

  { endpoint: "contacts:GET", scopes: ["settings.read"] },
  { endpoint: "contact-channels", scopes: ["settings.write"] },
  { endpoint: "contacts/invites", scopes: ["settings.read"] },
  { endpoint: "contacts/invites:POST", scopes: ["settings.write"] },
  { endpoint: "contacts/invites/redeem", scopes: ["settings.write"] },
  { endpoint: "contacts/invites:DELETE", scopes: ["settings.write"] },
  { endpoint: "contacts/prompt:POST", scopes: ["settings.write"] },
  { endpoint: "resolve_contact_prompt:POST", scopes: ["settings.write"] },
  { endpoint: "integrations/telegram/config", scopes: ["settings.read"] },
  { endpoint: "integrations/telegram/config:POST", scopes: ["settings.write"] },
  {
    endpoint: "integrations/telegram/config:DELETE",
    scopes: ["settings.write"],
  },
  { endpoint: "integrations/telegram/commands", scopes: ["settings.write"] },
  { endpoint: "integrations/telegram/setup", scopes: ["settings.write"] },
  { endpoint: "integrations/slack/channel/config", scopes: ["settings.read"] },
  {
    endpoint: "integrations/slack/channel/config:POST",
    scopes: ["settings.write"],
  },
  {
    endpoint: "integrations/slack/channel/config:DELETE",
    scopes: ["settings.write"],
  },
  { endpoint: "channel-verification-sessions", scopes: ["settings.write"] },
  {
    endpoint: "channel-verification-sessions:DELETE",
    scopes: ["settings.write"],
  },
  {
    endpoint: "channel-verification-sessions/resend",
    scopes: ["settings.write"],
  },
  {
    endpoint: "channel-verification-sessions/status",
    scopes: ["settings.read"],
  },
  {
    endpoint: "channel-verification-sessions/revoke",
    scopes: ["settings.write"],
  },
  { endpoint: "integrations/twilio/config", scopes: ["settings.read"] },
  {
    endpoint: "integrations/twilio/credentials:POST",
    scopes: ["settings.write"],
  },
  {
    endpoint: "integrations/twilio/credentials:DELETE",
    scopes: ["settings.write"],
  },
  { endpoint: "integrations/twilio/numbers", scopes: ["settings.read"] },
  {
    endpoint: "integrations/twilio/numbers/provision",
    scopes: ["settings.write"],
  },
  {
    endpoint: "integrations/twilio/numbers/assign",
    scopes: ["settings.write"],
  },
  {
    endpoint: "integrations/twilio/numbers/release",
    scopes: ["settings.write"],
  },
  // Slack share
  { endpoint: "slack/channels", scopes: ["settings.read"] },
  { endpoint: "slack/share", scopes: ["settings.write"] },

  // Channel readiness
  { endpoint: "channels/readiness", scopes: ["settings.read"] },
  { endpoint: "channels/readiness/refresh", scopes: ["settings.write"] },

  // Dead letters
  { endpoint: "channels/dead-letters", scopes: ["settings.read"] },
  { endpoint: "channels/replay", scopes: ["settings.write"] },

  // Secrets
  { endpoint: "secrets", scopes: ["settings.write"] },
  { endpoint: "secrets:GET", scopes: ["settings.read"] },
  { endpoint: "secrets/read", scopes: ["settings.write"] },

  // Pairing (authenticated)
  { endpoint: "pairing/register", scopes: ["settings.write"] },

  // Apps (existing share/shared routes)
  { endpoint: "apps/share", scopes: ["settings.write"] },
  { endpoint: "apps/shared:GET", scopes: ["settings.read"] },
  { endpoint: "apps/shared:DELETE", scopes: ["settings.write"] },
  { endpoint: "apps/shared/metadata", scopes: ["settings.read"] },

  // Apps management (CRUD, bundling, sharing, versioning)
  { endpoint: "apps", scopes: ["settings.read"] },
  { endpoint: "apps/data:GET", scopes: ["settings.read"] },
  { endpoint: "apps/data:POST", scopes: ["settings.write"] },
  { endpoint: "apps/open", scopes: ["settings.write"] },
  { endpoint: "apps/delete", scopes: ["settings.write"] },
  { endpoint: "apps/preview:GET", scopes: ["settings.read"] },
  { endpoint: "apps/preview:PUT", scopes: ["settings.write"] },
  { endpoint: "apps/history", scopes: ["settings.read"] },
  { endpoint: "apps/diff", scopes: ["settings.read"] },
  { endpoint: "apps/restore", scopes: ["settings.write"] },
  { endpoint: "apps/bundle", scopes: ["settings.write"] },
  { endpoint: "apps/open-bundle", scopes: ["settings.write"] },
  { endpoint: "apps/shared-list", scopes: ["settings.read"] },
  { endpoint: "apps/fork", scopes: ["settings.write"] },
  { endpoint: "apps/share-cloud", scopes: ["settings.write"] },
  { endpoint: "apps/gallery", scopes: ["settings.read"] },
  { endpoint: "apps/gallery/install", scopes: ["settings.write"] },
  { endpoint: "apps/sign-bundle", scopes: ["settings.write"] },
  { endpoint: "apps/signing-identity", scopes: ["settings.read"] },
  { endpoint: "apps/dist", scopes: ["settings.read"] },
  { endpoint: "pages", scopes: ["settings.read"] },

  // Usage / cost telemetry
  { endpoint: "usage/totals", scopes: ["settings.read"] },
  { endpoint: "usage/daily", scopes: ["settings.read"] },
  { endpoint: "usage/breakdown", scopes: ["settings.read"] },
  { endpoint: "usage/series", scopes: ["settings.read"] },

  // Lifecycle telemetry
  { endpoint: "telemetry/lifecycle", scopes: ["settings.write"] },

  // Debug / introspection
  { endpoint: "clients", scopes: ["settings.read"] },
  { endpoint: "clients/disconnect", scopes: ["settings.write"] },
  { endpoint: "debug", scopes: ["settings.read"] },

  // Workspace file browsing
  { endpoint: "workspace/tree", scopes: ["settings.read"] },
  { endpoint: "workspace/file", scopes: ["settings.read"] },
  { endpoint: "workspace/file/content", scopes: ["settings.read"] },
  { endpoint: "workspace/write", scopes: ["settings.write"] },
  { endpoint: "workspace/mkdir", scopes: ["settings.write"] },
  { endpoint: "workspace/rename", scopes: ["settings.write"] },
  { endpoint: "workspace/delete", scopes: ["settings.write"] },

  // Documents
  { endpoint: "documents:GET", scopes: ["settings.read"] },
  { endpoint: "documents:POST", scopes: ["settings.write"] },

  // Work items
  { endpoint: "work-items:GET", scopes: ["settings.read"] },
  { endpoint: "work-items:PATCH", scopes: ["settings.write"] },
  { endpoint: "work-items:DELETE", scopes: ["settings.write"] },
  { endpoint: "work-items/complete", scopes: ["settings.write"] },
  { endpoint: "work-items/cancel", scopes: ["settings.write"] },
  { endpoint: "work-items/approve-permissions", scopes: ["approval.write"] },
  { endpoint: "work-items/preflight", scopes: ["settings.read"] },
  { endpoint: "work-items/run", scopes: ["settings.write"] },
  { endpoint: "work-items/output", scopes: ["settings.read"] },

  // Subagents
  { endpoint: "subagents:GET", scopes: ["chat.read"] },
  { endpoint: "subagents/abort", scopes: ["chat.write"] },
  { endpoint: "subagents/message", scopes: ["chat.write"] },

  // ACP (Agent Communication Protocol)
  { endpoint: "acp/spawn", scopes: ["chat.write"] },
  { endpoint: "acp/steer", scopes: ["chat.write"] },
  { endpoint: "acp/cancel", scopes: ["chat.write"] },
  { endpoint: "acp/close", scopes: ["chat.write"] },
  { endpoint: "acp/sessions:DELETE", scopes: ["chat.write"] },
  { endpoint: "acp/sessions/delete", scopes: ["chat.write"] },
  { endpoint: "acp", scopes: ["chat.read"] },

  // Model config
  { endpoint: "model:GET", scopes: ["settings.read"] },
  { endpoint: "model:PUT", scopes: ["settings.write"] },
  { endpoint: "model/image-gen", scopes: ["settings.write"] },

  // Embedding config
  { endpoint: "config/embeddings:GET", scopes: ["settings.read"] },
  { endpoint: "config/embeddings:PUT", scopes: ["settings.write"] },

  // Generic config read/patch
  { endpoint: "config:GET", scopes: ["settings.read"] },
  { endpoint: "config:PATCH", scopes: ["settings.write"] },

  // LLM call site catalog
  { endpoint: "config/llm/call-sites:GET", scopes: ["settings.read"] },

  // Conversation management
  { endpoint: "conversations:DELETE", scopes: ["chat.write"] },
  { endpoint: "conversations/wipe", scopes: ["chat.write"] },
  { endpoint: "conversations/reorder", scopes: ["chat.write"] },

  // Conversation groups
  { endpoint: "groups:GET", scopes: ["chat.read"] },
  { endpoint: "groups:POST", scopes: ["chat.write"] },
  { endpoint: "groups:PATCH", scopes: ["chat.write"] },
  { endpoint: "groups:DELETE", scopes: ["chat.write"] },
  { endpoint: "groups/reorder", scopes: ["chat.write"] },

  // Conversation search
  { endpoint: "conversations/search", scopes: ["chat.read"] },

  // Conversation starters
  { endpoint: "conversation-starters", scopes: ["chat.read"] },
  { endpoint: "conversation-starters:DELETE", scopes: ["chat.write"] },

  // Message content
  { endpoint: "messages/content", scopes: ["chat.read"] },
  { endpoint: "messages/llm-context", scopes: ["chat.read"] },
  { endpoint: "llm-request-logs/payload", scopes: ["chat.read"] },
  { endpoint: "messages/tts", scopes: ["chat.read"] },
  { endpoint: "tts/synthesize", scopes: ["chat.read"] },

  // Queued message deletion
  { endpoint: "messages/queued", scopes: ["chat.write"] },

  // Interfaces
  { endpoint: "interfaces", scopes: ["settings.read"] },

  // Skills
  { endpoint: "skills:GET", scopes: ["settings.read"] },
  { endpoint: "skills:POST", scopes: ["settings.write"] },
  { endpoint: "skills:DELETE", scopes: ["settings.write"] },
  { endpoint: "skills:PATCH", scopes: ["settings.write"] },

  // Memory items
  { endpoint: "memory-items:GET", scopes: ["settings.read"] },
  { endpoint: "memory-items:POST", scopes: ["settings.write"] },
  { endpoint: "memory-items:PATCH", scopes: ["settings.write"] },
  { endpoint: "memory-items:DELETE", scopes: ["settings.write"] },
  { endpoint: "memory/v2/backfill:POST", scopes: ["settings.write"] },
  { endpoint: "memory/v2/validate:POST", scopes: ["settings.read"] },
  { endpoint: "memory/v2/concept-page:POST", scopes: ["settings.read"] },
  { endpoint: "memory/v2/reembed-skills:POST", scopes: ["settings.write"] },
  { endpoint: "memory/v2/explain-similarity:POST", scopes: ["settings.read"] },
  { endpoint: "memory/v2/fit-anisotropy:POST", scopes: ["settings.write"] },
  {
    endpoint: "memory/v2/rebuild-corpus-stats:POST",
    scopes: ["settings.write"],
  },
  { endpoint: "memory/v2/concept-frequency:POST", scopes: ["settings.read"] },
  { endpoint: "memory/v2/fit-anisotropy:POST", scopes: ["settings.write"] },

  // Trust rule listing
  { endpoint: "trust-rules/manage:GET", scopes: ["settings.read"] },

  // Computer use
  { endpoint: "computer-use/sessions", scopes: ["chat.write"] },
  { endpoint: "computer-use/sessions/abort", scopes: ["chat.write"] },
  { endpoint: "computer-use/observations", scopes: ["chat.write"] },
  { endpoint: "computer-use/tasks", scopes: ["chat.write"] },
  { endpoint: "computer-use/watch", scopes: ["chat.write"] },

  // Recordings
  { endpoint: "recordings/start", scopes: ["settings.write"] },
  { endpoint: "recordings/stop", scopes: ["settings.write"] },
  { endpoint: "recordings/pause", scopes: ["settings.write"] },
  { endpoint: "recordings/resume", scopes: ["settings.write"] },
  { endpoint: "recordings/status", scopes: ["settings.read"] },
  { endpoint: "recordings/status:POST", scopes: ["settings.write"] },

  // Surface actions
  { endpoint: "surface-actions", scopes: ["chat.write"] },
  { endpoint: "surfaces/undo", scopes: ["chat.write"] },
  { endpoint: "surfaces", scopes: ["chat.read"] },

  // Conversation deletion (channel-facing)
  { endpoint: "channels/conversation:DELETE", scopes: ["chat.write"] },

  // Delivery ack
  { endpoint: "channels/delivery-ack", scopes: ["internal.write"] },

  // Migrations
  { endpoint: "migrations/validate", scopes: ["settings.read"] },
  { endpoint: "migrations/export", scopes: ["settings.write"] },
  { endpoint: "migrations/export-to-gcs", scopes: ["settings.write"] },
  { endpoint: "migrations/import-preflight", scopes: ["settings.write"] },
  { endpoint: "migrations/import", scopes: ["settings.write"] },
  { endpoint: "migrations/import-from-gcs", scopes: ["settings.write"] },
  { endpoint: "migrations/jobs", scopes: ["settings.read"] },

  // Backups
  { endpoint: "backups", scopes: ["settings.read"] },
  { endpoint: "backups/create", scopes: ["settings.write"] },
  { endpoint: "backups/restore", scopes: ["settings.write"] },
  { endpoint: "backups/verify", scopes: ["settings.read"] },

  // Settings (voice, avatar, client settings)
  { endpoint: "settings/voice", scopes: ["settings.write"] },
  { endpoint: "settings/avatar/generate", scopes: ["settings.write"] },
  { endpoint: "avatar/character-components", scopes: ["settings.read"] },
  { endpoint: "avatar/render-from-traits", scopes: ["settings.write"] },
  { endpoint: "settings/client", scopes: ["settings.write"] },

  // Schedules
  { endpoint: "schedules", scopes: ["settings.read"] },
  { endpoint: "schedules:DELETE", scopes: ["settings.write"] },
  { endpoint: "schedules/toggle", scopes: ["settings.write"] },
  { endpoint: "schedules/run", scopes: ["settings.write"] },
  { endpoint: "schedules/cancel", scopes: ["settings.write"] },

  // Filing
  { endpoint: "filing", scopes: ["settings.read"] },
  { endpoint: "filing:POST", scopes: ["settings.write"] },

  // Consolidation (memory v2 counterpart to Filing)
  { endpoint: "consolidation", scopes: ["settings.read"] },
  { endpoint: "consolidation:POST", scopes: ["settings.write"] },

  // Gateway log proxy
  { endpoint: "gateway/logs/tail", scopes: ["settings.read"] },

  // Heartbeat (config, runs, checklist — all share the "heartbeat" policyKey)
  { endpoint: "heartbeat:GET", scopes: ["settings.read"] },
  { endpoint: "heartbeat", scopes: ["settings.write"] },

  // Notification delivery ack from clients
  { endpoint: "notification-intent-result", scopes: ["settings.write"] },

  // Platform config (base URL)
  { endpoint: "config/platform:GET", scopes: ["settings.read"] },
  { endpoint: "config/platform", scopes: ["settings.write"] },

  // Diagnostics
  { endpoint: "export", scopes: ["settings.read"] },
  { endpoint: "diagnostics/env-vars", scopes: ["settings.read"] },

  // Dictation
  { endpoint: "dictation", scopes: ["chat.write"] },

  // Speech-to-text
  { endpoint: "stt/providers", scopes: ["settings.read"] },
  { endpoint: "stt/transcribe", scopes: ["chat.write"] },

  // OAuth / integrations
  { endpoint: "oauth/start", scopes: ["settings.write"] },
  { endpoint: "integrations/oauth/start", scopes: ["settings.write"] }, // legacy alias
  { endpoint: "oauth/apps", scopes: ["settings.read"] },
  { endpoint: "oauth/apps.create", scopes: ["settings.write"] },
  { endpoint: "oauth/apps.delete", scopes: ["settings.write"] },
  { endpoint: "oauth/apps/connections", scopes: ["settings.read"] },
  { endpoint: "oauth/apps/connect", scopes: ["settings.write"] },
  { endpoint: "oauth/connections", scopes: ["settings.write"] },
  { endpoint: "oauth/providers", scopes: ["settings.read"] },

  // Ingress config
  { endpoint: "integrations/ingress/config:GET", scopes: ["settings.read"] },
  { endpoint: "integrations/ingress/config", scopes: ["settings.write"] },

  // Workspace files
  { endpoint: "workspace-files", scopes: ["settings.read"] },
  { endpoint: "workspace-files/read", scopes: ["settings.read"] },

  // Tools
  { endpoint: "tools", scopes: ["settings.read"] },
  { endpoint: "tools/simulate-permission", scopes: ["settings.read"] },
];

for (const { endpoint, scopes } of ACTOR_ENDPOINTS) {
  registerPolicy(endpoint, {
    requiredScopes: scopes,
    allowedPrincipalTypes: ["actor", "svc_gateway", "svc_daemon", "local"],
  });
}

// Clear-all conversations: elevated to settings.write (destructive bulk operation).
// Uses a distinct key so the single-conversation DELETE (conversations:DELETE)
// retains the lower chat.write scope.
registerPolicy("conversations/clear-all", {
  requiredScopes: ["settings.write"],
  allowedPrincipalTypes: ["actor", "svc_gateway", "svc_daemon", "local"],
});

// Event emission: gateway-only internal notification
registerPolicy("events/emit", {
  requiredScopes: ["internal.write"],
  allowedPrincipalTypes: ["svc_gateway"],
});

// Channel inbound: gateway-only
registerPolicy("channels/inbound", {
  requiredScopes: ["ingress.write"],
  allowedPrincipalTypes: ["svc_gateway"],
});

// Internal forwarding endpoints: gateway-only
const INTERNAL_ENDPOINTS = [
  "internal/twilio/voice-webhook",
  "internal/twilio/status",
  "internal/twilio/connect-action",
  "internal/oauth/callback",
  "internal/mcp/auth/start",
  "internal/mcp/auth/status",
  "internal/mcp/reload", // ← new
  "internal/oauth/connect/start",
  "internal/oauth/connect/status",
];
for (const endpoint of INTERNAL_ENDPOINTS) {
  registerPolicy(endpoint, {
    requiredScopes: ["internal.write"],
    allowedPrincipalTypes: ["svc_gateway"],
  });
}

// Admin control-plane endpoints: gateway-only
registerPolicy("admin/upgrade-broadcast", {
  requiredScopes: ["internal.write"],
  allowedPrincipalTypes: ["svc_gateway"],
});

registerPolicy("admin/workspace-commit", {
  requiredScopes: ["internal.write"],
  allowedPrincipalTypes: ["svc_gateway"],
});

registerPolicy("admin/rollback-migrations", {
  requiredScopes: ["internal.write"],
  allowedPrincipalTypes: ["svc_gateway"],
});

// Profiler management: gateway-only control-plane endpoints
registerPolicy("profiler/runs", {
  requiredScopes: ["internal.write"],
  allowedPrincipalTypes: ["svc_gateway"],
});

registerPolicy("profiler/runs/export", {
  requiredScopes: ["internal.write"],
  allowedPrincipalTypes: ["svc_gateway"],
});

// Attachment management: local-only (CLI / IPC callers)
registerPolicy("attachments/register", {
  requiredScopes: ["settings.write"],
  allowedPrincipalTypes: ["local"],
});

registerPolicy("attachments/lookup", {
  requiredScopes: ["settings.read"],
  allowedPrincipalTypes: ["local"],
});

registerPolicy("avatar/notify-updated", {
  requiredScopes: ["settings.write"],
  allowedPrincipalTypes: ["local"],
});

// Task templates and queue: local-only (CLI / IPC callers)
registerPolicy("tasks/save", {
  requiredScopes: ["settings.write"],
  allowedPrincipalTypes: ["local"],
});

registerPolicy("tasks/list", {
  requiredScopes: ["settings.read"],
  allowedPrincipalTypes: ["local"],
});

registerPolicy("tasks/run", {
  requiredScopes: ["settings.write"],
  allowedPrincipalTypes: ["local"],
});

registerPolicy("tasks/delete", {
  requiredScopes: ["settings.write"],
  allowedPrincipalTypes: ["local"],
});

registerPolicy("tasks/queue/show", {
  requiredScopes: ["settings.read"],
  allowedPrincipalTypes: ["local"],
});

registerPolicy("tasks/queue/add", {
  requiredScopes: ["settings.write"],
  allowedPrincipalTypes: ["local"],
});

registerPolicy("tasks/queue/update", {
  requiredScopes: ["settings.write"],
  allowedPrincipalTypes: ["local"],
});

registerPolicy("tasks/queue/remove", {
  requiredScopes: ["settings.write"],
  allowedPrincipalTypes: ["local"],
});

registerPolicy("tasks/queue/run", {
  requiredScopes: ["settings.write"],
  allowedPrincipalTypes: ["local"],
});

// Trust rule suggestion: local-only (gateway IPC)
// UI requests: local-only
registerPolicy("ui/request", {
  requiredScopes: ["settings.write"],
  allowedPrincipalTypes: ["local"],
});

// Watchers: local-only
registerPolicy("watchers/create", {
  requiredScopes: ["settings.write"],
  allowedPrincipalTypes: ["local"],
});

registerPolicy("watchers/list", {
  requiredScopes: ["settings.read"],
  allowedPrincipalTypes: ["local"],
});

registerPolicy("watchers/update", {
  requiredScopes: ["settings.write"],
  allowedPrincipalTypes: ["local"],
});

registerPolicy("watchers/delete", {
  requiredScopes: ["settings.write"],
  allowedPrincipalTypes: ["local"],
});

registerPolicy("watchers/digest", {
  requiredScopes: ["settings.read"],
  allowedPrincipalTypes: ["local"],
});

// Wipe conversation: local-only
registerPolicy("conversations/wipe", {
  requiredScopes: ["settings.write"],
  allowedPrincipalTypes: ["local"],
});

registerPolicy("trust-rules/suggest", {
  requiredScopes: ["settings.write"],
  allowedPrincipalTypes: ["actor", "svc_gateway", "svc_daemon", "local"],
});

// Notification pipeline: local-only (CLI / IPC callers)
registerPolicy("notifications/emit", {
  requiredScopes: ["settings.write"],
  allowedPrincipalTypes: ["local"],
});

registerPolicy("notifications/events", {
  requiredScopes: ["settings.read"],
  allowedPrincipalTypes: ["local"],
});

// Defer operations: local-only (CLI / IPC callers)
registerPolicy("defer/create", {
  requiredScopes: ["settings.write"],
  allowedPrincipalTypes: ["local"],
});

registerPolicy("defer/list", {
  requiredScopes: ["settings.read"],
  allowedPrincipalTypes: ["local"],
});

registerPolicy("defer/cancel", {
  requiredScopes: ["settings.write"],
  allowedPrincipalTypes: ["local"],
});

// Credential prompt: local-only (CLI / IPC callers)
registerPolicy("credentials/prompt", {
  requiredScopes: ["settings.write"],
  allowedPrincipalTypes: ["local"],
});

// Cache operations: local-only (CLI / IPC callers)
registerPolicy("cache/set", {
  requiredScopes: ["settings.write"],
  allowedPrincipalTypes: ["local"],
});

registerPolicy("cache/get", {
  requiredScopes: ["settings.read"],
  allowedPrincipalTypes: ["local"],
});

registerPolicy("cache/delete", {
  requiredScopes: ["settings.write"],
  allowedPrincipalTypes: ["local"],
});

// Browser operations: local-only (CLI / IPC callers)
registerPolicy("browser/execute", {
  requiredScopes: ["settings.write"],
  allowedPrincipalTypes: ["local"],
});

// Background tools: local-only (CLI / IPC callers)
registerPolicy("background-tools", {
  requiredScopes: ["settings.read"],
  allowedPrincipalTypes: ["local"],
});

registerPolicy("background-tools/cancel", {
  requiredScopes: ["settings.write"],
  allowedPrincipalTypes: ["local"],
});

// User-defined routes under /x/*
registerPolicy("x", {
  requiredScopes: ["settings.read"],
  allowedPrincipalTypes: ["actor", "svc_gateway", "svc_daemon", "local"],
});
