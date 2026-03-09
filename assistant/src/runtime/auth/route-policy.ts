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
export function registerPolicy(endpoint: string, policy: RoutePolicy): void {
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
  { endpoint: "conversations", scopes: ["chat.read"] },
  { endpoint: "conversations:DELETE", scopes: ["chat.write"] },
  { endpoint: "conversations/switch", scopes: ["chat.write"] },
  { endpoint: "conversations/name", scopes: ["chat.write"] },
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
  { endpoint: "pending-interactions", scopes: ["approval.read"] },

  // Guardian actions
  { endpoint: "guardian-actions/pending", scopes: ["approval.read"] },
  { endpoint: "guardian-actions/decision", scopes: ["approval.write"] },

  // Events (SSE)
  { endpoint: "events", scopes: ["chat.read"] },

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
  { endpoint: "identity", scopes: ["settings.read"] },
  { endpoint: "brain-graph", scopes: ["settings.read"] },
  { endpoint: "brain-graph-ui", scopes: ["settings.read"] },
  { endpoint: "home-base-ui", scopes: ["settings.read"] },
  { endpoint: "contacts", scopes: ["settings.read"] },
  { endpoint: "contacts:POST", scopes: ["settings.write"] },
  { endpoint: "contacts:DELETE", scopes: ["settings.write"] },
  { endpoint: "contacts/merge", scopes: ["settings.write"] },
  { endpoint: "contacts:GET", scopes: ["settings.read"] },
  { endpoint: "contact-channels", scopes: ["settings.write"] },
  { endpoint: "contacts/invites", scopes: ["settings.read"] },
  { endpoint: "contacts/invites:POST", scopes: ["settings.write"] },
  { endpoint: "contacts/invites/redeem", scopes: ["settings.write"] },
  { endpoint: "contacts/invites:DELETE", scopes: ["settings.write"] },
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

  // Usage / cost telemetry
  { endpoint: "usage/totals", scopes: ["settings.read"] },
  { endpoint: "usage/daily", scopes: ["settings.read"] },
  { endpoint: "usage/breakdown", scopes: ["settings.read"] },

  // Debug
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

  // Model config
  { endpoint: "model:GET", scopes: ["settings.read"] },
  { endpoint: "model:PUT", scopes: ["settings.write"] },
  { endpoint: "model/image-gen", scopes: ["settings.write"] },

  // Conversation search
  { endpoint: "conversations/search", scopes: ["chat.read"] },

  // Message content
  { endpoint: "messages/content", scopes: ["chat.read"] },

  // Queued message deletion
  { endpoint: "messages/queued", scopes: ["chat.write"] },

  // Browser relay
  { endpoint: "browser-relay/status", scopes: ["settings.read"] },
  { endpoint: "browser-relay/command", scopes: ["settings.write"] },

  // Interfaces
  { endpoint: "interfaces", scopes: ["settings.read"] },

  // Skills
  { endpoint: "skills:GET", scopes: ["settings.read"] },
  { endpoint: "skills:POST", scopes: ["settings.write"] },
  { endpoint: "skills:DELETE", scopes: ["settings.write"] },
  { endpoint: "skills:PATCH", scopes: ["settings.write"] },

  // Trust rule CRUD management
  { endpoint: "trust-rules/manage:GET", scopes: ["settings.read"] },
  { endpoint: "trust-rules/manage:POST", scopes: ["settings.write"] },
  { endpoint: "trust-rules/manage:DELETE", scopes: ["settings.write"] },
  { endpoint: "trust-rules/manage:PATCH", scopes: ["settings.write"] },

  // Computer use
  { endpoint: "computer-use/sessions", scopes: ["chat.write"] },
  { endpoint: "computer-use/sessions/abort", scopes: ["chat.write"] },
  { endpoint: "computer-use/observations", scopes: ["chat.write"] },
  { endpoint: "computer-use/tasks", scopes: ["chat.write"] },
  { endpoint: "computer-use/ride-shotgun/start", scopes: ["chat.write"] },
  { endpoint: "computer-use/ride-shotgun/stop", scopes: ["chat.write"] },
  { endpoint: "computer-use/ride-shotgun/status", scopes: ["chat.write"] },
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

  // Conversation deletion (channel-facing)
  { endpoint: "channels/conversation:DELETE", scopes: ["chat.write"] },

  // Delivery ack
  { endpoint: "channels/delivery-ack", scopes: ["internal.write"] },

  // Migrations
  { endpoint: "migrations/validate", scopes: ["settings.write"] },
  { endpoint: "migrations/export", scopes: ["settings.write"] },
  { endpoint: "migrations/import-preflight", scopes: ["settings.write"] },
  { endpoint: "migrations/import", scopes: ["settings.write"] },

  // Settings (voice, avatar, client settings)
  { endpoint: "settings/voice", scopes: ["settings.write"] },
  { endpoint: "settings/avatar/generate", scopes: ["settings.write"] },
  { endpoint: "settings/client", scopes: ["settings.write"] },

  // Schedules
  { endpoint: "schedules", scopes: ["settings.read"] },
  { endpoint: "schedules:DELETE", scopes: ["settings.write"] },
  { endpoint: "schedules/toggle", scopes: ["settings.write"] },
  { endpoint: "schedules/run", scopes: ["settings.write"] },

  // Diagnostics
  { endpoint: "diagnostics/export", scopes: ["settings.read"] },
  { endpoint: "diagnostics/env-vars", scopes: ["settings.read"] },

  // Dictation
  { endpoint: "dictation", scopes: ["chat.write"] },

  // OAuth / integrations
  { endpoint: "integrations/oauth/start", scopes: ["settings.write"] },
  { endpoint: "integrations/twitter/auth/start", scopes: ["settings.write"] },
  { endpoint: "integrations/twitter/auth/status", scopes: ["settings.read"] },

  // Home base
  { endpoint: "home-base", scopes: ["settings.read"] },

  // Workspace files (IPC-migrated)
  { endpoint: "workspace-files", scopes: ["settings.read"] },
  { endpoint: "workspace-files/read", scopes: ["settings.read"] },

  // Tools
  { endpoint: "tools", scopes: ["settings.read"] },
  { endpoint: "tools/simulate-permission", scopes: ["settings.read"] },
];

for (const { endpoint, scopes } of ACTOR_ENDPOINTS) {
  registerPolicy(endpoint, {
    requiredScopes: scopes,
    allowedPrincipalTypes: ["actor", "svc_gateway", "svc_daemon", "ipc"],
  });
}

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
];
for (const endpoint of INTERNAL_ENDPOINTS) {
  registerPolicy(endpoint, {
    requiredScopes: ["internal.write"],
    allowedPrincipalTypes: ["svc_gateway"],
  });
}
