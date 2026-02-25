import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import {
  getSecureKey,
  setSecureKey,
  deleteSecureKey,
  getBackendType,
  listSecureKeys,
  isDowngradedFromKeychain,
} from '../../security/secure-keys.js';
import { upsertCredentialMetadata, deleteCredentialMetadata, getCredentialMetadata, listCredentialMetadata, assertMetadataWritable } from './metadata-store.js';
import { validatePolicyInput, toPolicyFromInput } from './policy-validate.js';
import type { CredentialPolicyInput, CredentialInjectionTemplate } from './policy-types.js';
import { credentialBroker } from './broker.js';
import { startOAuth2Flow, prepareOAuth2Flow, type OAuth2FlowResult, type TokenEndpointAuthMethod } from '../../security/oauth2.js';
import { runPostConnectHook } from './post-connect-hooks.js';
import { getConfig } from '../../config/loader.js';
import { getLogger } from '../../util/logger.js';

const log = getLogger('credential-vault');

// ---------------------------------------------------------------------------
// Well-known OAuth configurations for auto-connect.
// When oauth2_connect is called with just a service name, missing parameters
// (auth_url, token_url, scopes, etc.) are filled from this registry.
// ---------------------------------------------------------------------------

interface WellKnownOAuthConfig {
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  userinfoUrl?: string;
  extraParams?: Record<string, string>;
  /** How to send client credentials at the token endpoint. Defaults to client_secret_post. */
  tokenEndpointAuthMethod?: TokenEndpointAuthMethod;
  /** Injection templates auto-applied to the access_token credential after a successful OAuth2 connect. */
  injectionTemplates?: CredentialInjectionTemplate[];
  /** Force a specific callback transport (e.g. 'loopback' for Desktop app credentials). */
  callbackTransport?: 'loopback' | 'gateway';
  /** Fixed port for loopback transport. Required for providers like Slack that
   *  need pre-registered redirect URIs and cannot use a random port. */
  loopbackPort?: number;
  /** Metadata for the generic OAuth setup skill. When present, the assistant
   *  can guide users through app creation and OAuth connection without a
   *  provider-specific setup skill. */
  setup?: {
    /** Human-readable provider name (e.g., "Discord", "Linear") */
    displayName: string;
    /** URL of the developer dashboard where the user creates an app */
    dashboardUrl: string;
    /** What the provider calls its apps (e.g., "Discord Application", "Linear OAuth App") */
    appType: string;
    /** Whether the provider requires a client_secret for token exchange */
    requiresClientSecret: boolean;
    /** Provider-specific notes the LLM should follow during setup */
    notes?: string[];
  };
}

const WELL_KNOWN_OAUTH: Record<string, WellKnownOAuthConfig> = {
  'integration:gmail': {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/contacts.readonly',
    ],
    userinfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
    extraParams: { access_type: 'offline', prompt: 'consent' },
    callbackTransport: 'loopback',
  },
  'integration:slack': {
    authUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    scopes: [
      'channels:read', 'channels:history',
      'groups:read', 'groups:history',
      'im:read', 'im:history', 'im:write',
      'mpim:read', 'mpim:history',
      'users:read', 'chat:write',
      'search:read', 'reactions:write',
    ],
    extraParams: {
      user_scope: 'channels:read,channels:history,groups:read,groups:history,im:read,im:history,im:write,mpim:read,mpim:history,users:read,chat:write,search:read,reactions:write',
    },
    callbackTransport: 'loopback',
    loopbackPort: 17322,
  },
  // Notion uses a simple OAuth2 flow with client_secret_basic auth at the token endpoint.
  // The access token is long-lived (no expiry) and scopes are configured per-integration in Notion
  // (the authorization URL accepts owner=user but there are no traditional scope strings to request).
  'integration:notion': {
    authUrl: 'https://api.notion.com/v1/oauth/authorize',
    tokenUrl: 'https://api.notion.com/v1/oauth/token',
    scopes: [],
    extraParams: { owner: 'user' },
    // Notion requires HTTP Basic Auth (base64 of client_id:client_secret) at the token endpoint,
    // not the default client_secret_post form-body approach.
    tokenEndpointAuthMethod: 'client_secret_basic',
    // Auto-inject the Bearer token for all Notion API calls made through the sandbox proxy.
    injectionTemplates: [
      {
        hostPattern: 'api.notion.com',
        injectionType: 'header',
        headerName: 'Authorization',
        valuePrefix: 'Bearer ',
      },
    ],
  },
};

/** Map shorthand aliases to canonical service names. */
const SERVICE_ALIASES: Record<string, string> = {
  gmail: 'integration:gmail',
  slack: 'integration:slack',
  notion: 'integration:notion',
};

/** Resolve a service name through aliases. */
function resolveService(service: string): string {
  return SERVICE_ALIASES[service] ?? service;
}

/**
 * Look up a stored client_id or client_secret for a service.
 * Checks common field names across both the canonical and alias service names.
 */
function findStoredOAuthField(service: string, fieldNames: string[]): string | undefined {
  const servicesToCheck = [service];
  // Also check the alias if the input is the canonical name, or vice versa
  for (const [alias, canonical] of Object.entries(SERVICE_ALIASES)) {
    if (canonical === service) servicesToCheck.push(alias);
    if (alias === service) servicesToCheck.push(canonical);
  }
  for (const svc of servicesToCheck) {
    for (const field of fieldNames) {
      const value = getSecureKey(`credential:${svc}:${field}`);
      if (value) return value;
    }
  }

  // Legacy fallback: check credential metadata on the access_token record.
  // Older OAuth2 flows stored client_id/client_secret only in metadata JSON.
  // New flows persist them in the keychain (checked above) for defense in depth.
  const metadataKey = fieldNames.some((f) => f.includes('client_id'))
    ? 'oauth2ClientId' as const
    : 'oauth2ClientSecret' as const;
  for (const svc of servicesToCheck) {
    const meta = getCredentialMetadata(svc, 'access_token');
    const value = meta?.[metadataKey];
    if (value) {
      log.debug({ service: svc, field: metadataKey }, 'OAuth client credential resolved from metadata (legacy fallback)');
      return value;
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Shared helper: store OAuth2 tokens + metadata after a successful flow.
// Used by both the interactive (desktop) and deferred (channel) paths.
// ---------------------------------------------------------------------------

interface StoreOAuth2TokensParams {
  service: string;
  tokens: OAuth2FlowResult['tokens'];
  grantedScopes: string[];
  rawTokenResponse: Record<string, unknown>;
  clientId: string;
  clientSecret?: string;
  tokenUrl: string;
  tokenEndpointAuthMethod?: TokenEndpointAuthMethod;
  userinfoUrl?: string;
  allowedTools?: string[];
  wellKnownInjectionTemplates?: CredentialInjectionTemplate[];
}

async function storeOAuth2Tokens(params: StoreOAuth2TokensParams): Promise<{ accountInfo?: string }> {
  const { service, tokens, grantedScopes, rawTokenResponse, clientId, clientSecret, tokenUrl, tokenEndpointAuthMethod, userinfoUrl, allowedTools, wellKnownInjectionTemplates } = params;

  const tokenStored = setSecureKey(`credential:${service}:access_token`, tokens.accessToken);
  if (!tokenStored) {
    throw new Error('Failed to store access token in secure storage');
  }

  const expiresAt = tokens.expiresIn ? Date.now() + tokens.expiresIn * 1000 : null;

  let accountInfo: string | undefined;
  if (userinfoUrl && grantedScopes.some((s) => s.includes('userinfo'))) {
    try {
      const resp = await fetch(userinfoUrl, {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      });
      if (resp.ok) {
        const info = await resp.json() as { email?: string };
        accountInfo = info.email;
      }
    } catch {
      // Non-fatal
    }
  }

  // Persist client credentials in keychain for defense in depth
  const clientIdStored = setSecureKey(`credential:${service}:client_id`, clientId);
  if (!clientIdStored) {
    throw new Error('Failed to store client_id in secure storage');
  }
  if (clientSecret) {
    const clientSecretStored = setSecureKey(`credential:${service}:client_secret`, clientSecret);
    if (!clientSecretStored) {
      throw new Error('Failed to store client_secret in secure storage');
    }
  }

  upsertCredentialMetadata(service, 'access_token', {
    allowedTools: allowedTools ?? [],
    expiresAt,
    grantedScopes,
    accountInfo: accountInfo ?? null,
    oauth2TokenUrl: tokenUrl,
    oauth2ClientId: clientId,
    ...(clientSecret ? { oauth2ClientSecret: clientSecret } : {}),
    ...(tokenEndpointAuthMethod ? { oauth2TokenEndpointAuthMethod: tokenEndpointAuthMethod } : {}),
    ...(wellKnownInjectionTemplates ? { injectionTemplates: wellKnownInjectionTemplates } : {}),
  });

  if (tokens.refreshToken) {
    const refreshStored = setSecureKey(`credential:${service}:refresh_token`, tokens.refreshToken);
    if (refreshStored) {
      upsertCredentialMetadata(service, 'refresh_token', {});
    }
  }

  // Run any provider-specific post-connect actions (e.g. Slack welcome DM)
  await runPostConnectHook({ service, rawTokenResponse });

  return { accountInfo };
}

class CredentialStoreTool implements Tool {
  name = 'credential_store';
  description = 'Store, list, delete, or prompt for credentials in the secure vault';
  category = 'credentials';
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['store', 'list', 'delete', 'prompt', 'oauth2_connect', 'describe'],
            description: 'The operation to perform. Use "prompt" to ask the user for a secret via secure UI — the value never enters the conversation. Use "oauth2_connect" to connect an OAuth2 service via browser authorization. Use "describe" to get setup metadata for a well-known OAuth service (dashboard URL, scopes, redirect URI, etc.). For well-known services (gmail, slack), only the service name is required — endpoints, scopes, and stored client credentials are resolved automatically.',
          },
          service: {
            type: 'string',
            description: 'Service name, e.g. gmail, github',
          },
          field: {
            type: 'string',
            description: 'Field name, e.g. password, username, recovery_email',
          },
          value: {
            type: 'string',
            description: 'The credential value (only for store action)',
          },
          label: {
            type: 'string',
            description: 'Display label for the prompt UI (only for prompt action), e.g. "GitHub Personal Access Token"',
          },
          description: {
            type: 'string',
            description: 'Optional context shown in the prompt UI (only for prompt action), e.g. "Needed to push changes"',
          },
          placeholder: {
            type: 'string',
            description: 'Placeholder text for the input field (only for prompt action), e.g. "ghp_xxxxxxxxxxxx"',
          },
          allowed_tools: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tools allowed to use this credential (for store/prompt actions), e.g. ["browser_fill_credential"]. Empty = deny all.',
          },
          allowed_domains: {
            type: 'array',
            items: { type: 'string' },
            description: 'Domains where this credential may be used (for store/prompt actions), e.g. ["github.com"]. Empty = deny all.',
          },
          usage_description: {
            type: 'string',
            description: 'Human-readable description of intended usage (for store/prompt actions), e.g. "GitHub login for pushing changes"',
          },
          auth_url: {
            type: 'string',
            description: 'OAuth2 authorization endpoint (only for oauth2_connect action). Auto-filled for well-known services (gmail, slack).',
          },
          token_url: {
            type: 'string',
            description: 'OAuth2 token endpoint (only for oauth2_connect action). Auto-filled for well-known services (gmail, slack).',
          },
          scopes: {
            type: 'array',
            items: { type: 'string' },
            description: 'OAuth2 scopes to request (only for oauth2_connect action). Auto-filled for well-known services (gmail, slack).',
          },
          client_id: {
            type: 'string',
            description: 'OAuth2 client ID (only for oauth2_connect action). If omitted, looked up from previously stored credentials.',
          },
          extra_params: {
            type: 'object',
            description: 'Extra query params for OAuth2 auth URL (only for oauth2_connect action)',
          },
          userinfo_url: {
            type: 'string',
            description: 'Endpoint to fetch account info after OAuth2 auth (only for oauth2_connect action)',
          },
          client_secret: {
            type: 'string',
            description: 'OAuth2 client secret for providers that require it (e.g. Google, Slack). If omitted, looked up from previously stored credentials; if still absent, PKCE-only is used (only for oauth2_connect action)',
          },
          token_endpoint_auth_method: {
            type: 'string',
            enum: ['client_secret_basic', 'client_secret_post'],
            description: 'How to send client credentials at the token endpoint: "client_secret_post" (default, in POST body) or "client_secret_basic" (HTTP Basic Auth header). Only for oauth2_connect action.',
          },
          alias: {
            type: 'string',
            description: 'Human-friendly name for this credential (only for store action), e.g. "fal-primary"',
          },
          injection_templates: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                hostPattern: { type: 'string', description: 'Glob pattern for matching request hosts, e.g. "*.fal.ai"' },
                injectionType: { type: 'string', enum: ['header', 'query'], description: 'Where to inject the credential value' },
                headerName: { type: 'string', description: 'Header name when injectionType is "header"' },
                valuePrefix: { type: 'string', description: 'Prefix prepended to the secret value, e.g. "Key ", "Bearer "' },
                queryParamName: { type: 'string', description: 'Query parameter name when injectionType is "query"' },
              },
              required: ['hostPattern', 'injectionType'],
            },
            description: 'Templates describing how to inject this credential into proxied requests (only for store action)',
          },
        },
        required: ['action'],
      },
    };
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    const action = input.action as string;

    switch (action) {
      case 'store': {
        const service = input.service as string | undefined;
        const field = input.field as string | undefined;
        const value = input.value as string | undefined;

        if (!service || typeof service !== 'string') {
          return { content: 'Error: service is required for store action', isError: true };
        }
        if (!field || typeof field !== 'string') {
          return { content: 'Error: field is required for store action', isError: true };
        }
        if (!value || typeof value !== 'string') {
          return { content: 'Error: value is required for store action', isError: true };
        }

        const policyInput: CredentialPolicyInput = {
          allowed_tools: input.allowed_tools as string[] | undefined,
          allowed_domains: input.allowed_domains as string[] | undefined,
          usage_description: input.usage_description as string | undefined,
        };
        const policyResult = validatePolicyInput(policyInput);
        if (!policyResult.valid) {
          return { content: `Error: ${policyResult.errors.join('; ')}`, isError: true };
        }
        const policy = toPolicyFromInput(policyInput);

        const alias = input.alias;
        if (alias !== undefined && typeof alias !== 'string') {
          return { content: 'Error: alias must be a string', isError: true };
        }
        const rawTemplates = input.injection_templates as unknown[] | undefined;

        // Validate injection templates
        let injectionTemplates: CredentialInjectionTemplate[] | undefined;
        if (rawTemplates !== undefined) {
          if (!Array.isArray(rawTemplates)) {
            return { content: 'Error: injection_templates must be an array', isError: true };
          }
          const templateErrors: string[] = [];
          injectionTemplates = [];
          for (let i = 0; i < rawTemplates.length; i++) {
            const t = rawTemplates[i] as Record<string, unknown>;
            if (typeof t !== 'object' || t == null) {
              templateErrors.push(`injection_templates[${i}] must be an object`);
              continue;
            }
            if (typeof t.hostPattern !== 'string' || t.hostPattern.trim().length === 0) {
              templateErrors.push(`injection_templates[${i}].hostPattern must be a non-empty string`);
            }
            if (t.injectionType !== 'header' && t.injectionType !== 'query') {
              templateErrors.push(`injection_templates[${i}].injectionType must be 'header' or 'query'`);
            } else if (t.injectionType === 'header') {
              if (typeof t.headerName !== 'string' || t.headerName.trim().length === 0) {
                templateErrors.push(`injection_templates[${i}].headerName is required when injectionType is 'header'`);
              }
            } else if (t.injectionType === 'query') {
              if (typeof t.queryParamName !== 'string' || t.queryParamName.trim().length === 0) {
                templateErrors.push(`injection_templates[${i}].queryParamName is required when injectionType is 'query'`);
              }
            }
            if (t.valuePrefix !== undefined && typeof t.valuePrefix !== 'string') {
              templateErrors.push(`injection_templates[${i}].valuePrefix must be a string`);
            }
            if (templateErrors.length === 0) {
              injectionTemplates.push({
                hostPattern: t.hostPattern as string,
                injectionType: t.injectionType as 'header' | 'query',
                headerName: typeof t.headerName === 'string' ? t.headerName : undefined,
                valuePrefix: typeof t.valuePrefix === 'string' ? t.valuePrefix : undefined,
                queryParamName: typeof t.queryParamName === 'string' ? t.queryParamName : undefined,
              });
            }
          }
          if (templateErrors.length > 0) {
            return { content: `Error: ${templateErrors.join('; ')}`, isError: true };
          }
        }

        try {
          assertMetadataWritable();
        } catch {
          return { content: 'Error: credential metadata file has an unrecognized version; cannot store credentials', isError: true };
        }

        const key = `credential:${service}:${field}`;
        const ok = setSecureKey(key, value);
        if (!ok) {
          return { content: 'Error: failed to store credential', isError: true };
        }
        try {
          upsertCredentialMetadata(service, field, {
            allowedTools: policy.allowedTools,
            allowedDomains: policy.allowedDomains,
            usageDescription: policy.usageDescription,
            alias,
            injectionTemplates,
          });
        } catch (err) {
          log.warn({ service, field, err }, 'metadata write failed after storing credential');
        }
        const metadata = getCredentialMetadata(service, field);
        const credIdSuffix = metadata ? ` (credential_id: ${metadata.credentialId})` : '';
        return { content: `Stored credential for ${service}/${field}.${credIdSuffix}`, isError: false };
      }

      case 'list': {
        try {
          assertMetadataWritable();
        } catch {
          return { content: 'Error: credential metadata file has an unrecognized version; cannot list credentials', isError: true };
        }

        const allMetadata = listCredentialMetadata();
        // On the encrypted backend we can verify secrets still exist by reading
        // all key names once (instead of per-entry getSecureKey calls that each
        // re-read/re-derive the store). On keychain we trust metadata since the
        // OS keychain has no batch list API.
        // In downgraded mode (keychain failed, switched to encrypted), skip
        // batch verification because listSecureKeys() only returns keys from
        // the encrypted store — keychain-only credentials would be hidden.
        const downgraded = isDowngradedFromKeychain();
        const verifySecrets = getBackendType() === 'encrypted' && !downgraded;
        let secureKeySet: Set<string> | undefined;
        if (verifySecrets) {
          try {
            secureKeySet = new Set(listSecureKeys());
          } catch (err) {
            log.error({ err }, 'Failed to read secure store while listing credentials');
            return { content: 'Error: failed to read secure storage; cannot list credentials', isError: true };
          }
        }
        const entries = allMetadata
          .filter((m) => {
            if (secureKeySet) return secureKeySet.has(`credential:${m.service}:${m.field}`);
            return true;
          })
          .map((m) => {
            const entry: Record<string, unknown> = {
              credential_id: m.credentialId,
              service: m.service,
              field: m.field,
            };
            if (m.alias) {
              entry.alias = m.alias;
            }
            if (m.injectionTemplates && m.injectionTemplates.length > 0) {
              entry.injection_templates = {
                count: m.injectionTemplates.length,
                host_patterns: m.injectionTemplates.map((t) => t.hostPattern),
              };
            }
            return entry;
          });
        return { content: JSON.stringify(entries, null, 2), isError: false };
      }

      case 'delete': {
        const service = input.service as string | undefined;
        const field = input.field as string | undefined;

        if (!service || typeof service !== 'string') {
          return { content: 'Error: service is required for delete action', isError: true };
        }
        if (!field || typeof field !== 'string') {
          return { content: 'Error: field is required for delete action', isError: true };
        }

        try {
          assertMetadataWritable();
        } catch {
          return { content: 'Error: credential metadata file has an unrecognized version; cannot delete credentials', isError: true };
        }

        const key = `credential:${service}:${field}`;
        const ok = deleteSecureKey(key);
        if (!ok) {
          return { content: `Error: credential ${service}/${field} not found`, isError: true };
        }
        try {
          deleteCredentialMetadata(service, field);
        } catch (err) {
          log.warn({ service, field, err }, 'metadata delete failed after removing credential');
        }
        return { content: `Deleted credential for ${service}/${field}.`, isError: false };
      }

      case 'prompt': {
        const service = input.service as string | undefined;
        const field = input.field as string | undefined;

        if (!service || typeof service !== 'string') {
          return { content: 'Error: service is required for prompt action', isError: true };
        }
        if (!field || typeof field !== 'string') {
          return { content: 'Error: field is required for prompt action', isError: true };
        }

        if (!context.requestSecret) {
          return { content: 'Error: secret prompting not available in this context', isError: true };
        }

        const label = (input.label as string) || `${service} ${field}`;
        const description = input.description as string | undefined;
        const placeholder = input.placeholder as string | undefined;

        const promptPolicyInput: CredentialPolicyInput = {
          allowed_tools: input.allowed_tools as string[] | undefined,
          allowed_domains: input.allowed_domains as string[] | undefined,
          usage_description: input.usage_description as string | undefined,
        };
        const promptPolicyResult = validatePolicyInput(promptPolicyInput);
        if (!promptPolicyResult.valid) {
          return { content: `Error: ${promptPolicyResult.errors.join('; ')}`, isError: true };
        }
        const promptPolicy = toPolicyFromInput(promptPolicyInput);

        try {
          assertMetadataWritable();
        } catch {
          return { content: 'Error: credential metadata file has an unrecognized version; cannot store credentials', isError: true };
        }

        const result = await context.requestSecret({
          service, field, label, description, placeholder,
          purpose: promptPolicy.usageDescription,
          allowedTools: promptPolicy.allowedTools.length > 0 ? promptPolicy.allowedTools : undefined,
          allowedDomains: promptPolicy.allowedDomains.length > 0 ? promptPolicy.allowedDomains : undefined,
        });
        if (!result.value) {
          return { content: 'User cancelled the credential prompt.', isError: false };
        }

        // Handle one-time send delivery: inject into context without persisting
        if (result.delivery === 'transient_send') {
          const config = getConfig();
          if (!config.secretDetection.allowOneTimeSend) {
            log.warn({ service, field }, 'One-time send requested but not enabled in config');
            return {
              content: 'Error: one-time send is not enabled. Set secretDetection.allowOneTimeSend to true in config.',
              isError: true,
            };
          }
          // Ensure metadata exists so broker policy checks work, but don't
          // overwrite an existing record — a stored credential's policy should
          // not be silently replaced by the transient prompt's policy.
          // Metadata must be written before injecting the transient value so
          // we never leave a dangling value that fails policy checks.
          if (!getCredentialMetadata(service, field)) {
            try {
              upsertCredentialMetadata(service, field, {
                allowedTools: promptPolicy.allowedTools,
                allowedDomains: promptPolicy.allowedDomains,
                usageDescription: promptPolicy.usageDescription,
              });
            } catch (err) {
              // Without metadata the broker's policy checks will reject usage,
              // so the transient value would be silently unusable. Fail loudly.
              log.error({ service, field, err }, 'metadata write failed for transient credential');
              return {
                content: `Error: failed to write credential metadata for ${service}/${field}; the one-time value was discarded.`,
                isError: true,
              };
            }
          }
          // Inject into broker for one-time use by the next tool call, then discard
          credentialBroker.injectTransient(service, field, result.value);
          log.info({ service, field, delivery: 'transient_send' }, 'One-time secret delivery used');
          return {
            content: `One-time credential provided for ${service}/${field}. The value was NOT saved to the vault and will be consumed by the next operation.`,
            isError: false,
          };
        }

        // Default: persist to keychain
        const key = `credential:${service}:${field}`;
        const ok = setSecureKey(key, result.value);
        if (!ok) {
          return { content: 'Error: failed to store credential', isError: true };
        }
        try {
          upsertCredentialMetadata(service, field, {
            allowedTools: promptPolicy.allowedTools,
            allowedDomains: promptPolicy.allowedDomains,
            usageDescription: promptPolicy.usageDescription,
          });
        } catch (err) {
          log.warn({ service, field, err }, 'metadata write failed after storing credential');
        }
        const promptMeta = getCredentialMetadata(service, field);
        const promptCredIdSuffix = promptMeta ? ` (credential_id: ${promptMeta.credentialId})` : '';
        return { content: `Credential stored for ${service}/${field}.${promptCredIdSuffix}`, isError: false };
      }

      case 'oauth2_connect': {
        const rawService = input.service as string | undefined;
        if (!rawService) return { content: 'Error: service is required for oauth2_connect action', isError: true };

        // Resolve aliases (e.g. "gmail" → "integration:gmail")
        const service = resolveService(rawService);

        // Fill missing params from well-known config
        const wellKnown = WELL_KNOWN_OAUTH[service];
        const authUrl = (input.auth_url as string | undefined) ?? wellKnown?.authUrl;
        const tokenUrl = (input.token_url as string | undefined) ?? wellKnown?.tokenUrl;
        const scopes = (input.scopes as string[] | undefined) ?? wellKnown?.scopes;
        const extraParams = (input.extra_params as Record<string, string> | undefined) ?? wellKnown?.extraParams;
        const userinfoUrl = (input.userinfo_url as string | undefined) ?? wellKnown?.userinfoUrl;

        // Look up client_id/client_secret from stored credentials if not provided
        const clientId = (input.client_id as string | undefined)
          ?? findStoredOAuthField(service, ['client_id', 'oauth_client_id']);
        const clientSecret = (input.client_secret as string | undefined)
          ?? findStoredOAuthField(service, ['client_secret', 'oauth_client_secret']);
        const tokenEndpointAuthMethod = (input.token_endpoint_auth_method as TokenEndpointAuthMethod | undefined)
          ?? wellKnown?.tokenEndpointAuthMethod;

        if (!authUrl) return { content: 'Error: auth_url is required for oauth2_connect action (no well-known config for this service)', isError: true };
        if (!tokenUrl) return { content: 'Error: token_url is required for oauth2_connect action (no well-known config for this service)', isError: true };
        // Scopes are optional — some providers (e.g. Notion) configure authorization at the integration
        // level and don't use traditional scope strings. Reject only when scopes is entirely absent (not
        // provided and no well-known config), not when it is an empty array.
        if (!scopes) return { content: 'Error: scopes is required for oauth2_connect action (no well-known config for this service)', isError: true };
        if (!clientId) return { content: 'Error: client_id is required for oauth2_connect action. Provide it directly or store it first with credential_store.', isError: true };

        try {
          assertMetadataWritable();
        } catch {
          return { content: 'Error: credential metadata file has an unrecognized version; cannot store credentials', isError: true };
        }

        const allowedTools = input.allowed_tools as string[] | undefined;
        const wellKnownInjectionTemplates = wellKnown?.injectionTemplates;
        const oauthConfig = { authUrl, tokenUrl, scopes, clientId, clientSecret, extraParams, userinfoUrl, tokenEndpointAuthMethod };
        const storageParams = {
          service, clientId, clientSecret, tokenUrl, tokenEndpointAuthMethod,
          userinfoUrl, allowedTools, wellKnownInjectionTemplates,
        };

        if (!context.isInteractive) {
          // Channel path: return the auth URL as text for the user to open manually.
          // Token storage happens asynchronously when the callback arrives.
          try {
            const callbackTransport = wellKnown?.callbackTransport ?? 'gateway';

            // Gateway transport needs a public ingress URL; loopback runs locally
            // on the daemon so it works regardless of ingress configuration.
            if (callbackTransport !== 'loopback') {
              const { loadConfig } = await import('../../config/loader.js');
              const { getPublicBaseUrl } = await import('../../inbound/public-ingress-urls.js');
              try {
                getPublicBaseUrl(loadConfig());
              } catch {
                return {
                  content: 'Error: oauth2_connect from a non-interactive session requires a public ingress URL. Configure ingress.publicBaseUrl first.',
                  isError: true,
                };
              }
            }

            const prepared = await prepareOAuth2Flow(
              oauthConfig,
              callbackTransport === 'loopback'
                ? { callbackTransport, loopbackPort: wellKnown?.loopbackPort }
                : undefined,
            );

            // Fire-and-forget: when the callback arrives, store tokens in the background
            prepared.completion.then(async (result) => {
              try {
                const { accountInfo } = await storeOAuth2Tokens({
                  ...storageParams,
                  tokens: result.tokens,
                  grantedScopes: result.grantedScopes,
                  rawTokenResponse: result.rawTokenResponse,
                });
                log.info({ service, accountInfo }, 'Deferred OAuth2 flow completed — tokens stored');
              } catch (err) {
                log.error({ err, service }, 'Failed to store tokens from deferred OAuth2 flow');
              }
            }).catch((err) => {
              log.error({ err, service }, 'Deferred OAuth2 flow failed');
            });

            return {
              content: `To connect ${rawService}, open this link and authorize access:\n\n${prepared.authUrl}\n\nOnce you authorize, the connection will be set up automatically. You can verify by asking me to check your inbox.`,
              isError: false,
            };
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : 'Unknown error preparing OAuth flow';
            return { content: `Error connecting "${service}": ${message}`, isError: true };
          }
        }

        // Interactive path (desktop): open browser and wait for completion
        try {
          const { tokens, grantedScopes, rawTokenResponse } = await startOAuth2Flow(
            oauthConfig,
            {
              openUrl: (url) => {
                context.sendToClient?.({ type: 'open_url', url, title: `Connect ${service}` });
              },
            },
            wellKnown?.callbackTransport ? { callbackTransport: wellKnown.callbackTransport, loopbackPort: wellKnown.loopbackPort } : undefined,
          );

          const { accountInfo } = await storeOAuth2Tokens({
            ...storageParams,
            tokens,
            grantedScopes,
            rawTokenResponse,
          });

          return {
            content: `Successfully connected "${service}"${accountInfo ? ` as ${accountInfo}` : ''}. The service is now ready to use.`,
            isError: false,
          };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Unknown error during OAuth flow';
          return { content: `Error connecting "${service}": ${message}`, isError: true };
        }
      }

      case 'describe': {
        const rawService = (input.service as string | undefined) ?? '';
        const service = SERVICE_ALIASES[rawService] ?? rawService;
        if (!service) {
          return { content: 'Error: service is required for describe action', isError: true };
        }
        // Try direct lookup, then fall back to integration: prefix for
        // newly added providers that may not have a SERVICE_ALIASES entry yet.
        const wellKnown = WELL_KNOWN_OAUTH[service]
          ?? (!service.includes(':') ? WELL_KNOWN_OAUTH[`integration:${service}`] : undefined);
        const resolvedService = WELL_KNOWN_OAUTH[service] ? service
          : (!service.includes(':') && WELL_KNOWN_OAUTH[`integration:${service}`]) ? `integration:${service}`
            : service;
        if (!wellKnown) {
          return { content: `No well-known OAuth config found for "${rawService}". Available services: ${Object.keys(SERVICE_ALIASES).join(', ')}`, isError: false };
        }

        // Compute the redirect URI based on callback transport
        let redirectUri: string;
        const transport = wellKnown.callbackTransport ?? 'gateway';
        if (transport === 'loopback' && wellKnown.loopbackPort) {
          redirectUri = `http://127.0.0.1:${wellKnown.loopbackPort}/oauth/callback`;
        } else if (transport === 'loopback') {
          redirectUri = '(automatic — no redirect URI needed, uses random localhost port)';
        } else {
          // Try to compute the actual URL from config/env
          try {
            const { loadConfig } = await import('../../config/loader.js');
            const { getPublicBaseUrl } = await import('../../inbound/public-ingress-urls.js');
            const baseUrl = getPublicBaseUrl(loadConfig());
            redirectUri = `${baseUrl}/webhooks/oauth/callback`;
          } catch {
            redirectUri = '(requires INGRESS_PUBLIC_BASE_URL — not currently configured)';
          }
        }

        // Prefer explicit setup metadata, fall back to heuristic
        const requiresClientSecret = wellKnown.setup?.requiresClientSecret
          ?? !!(wellKnown.tokenEndpointAuthMethod || wellKnown.extraParams);

        const info: Record<string, unknown> = {
          service: resolvedService,
          authUrl: wellKnown.authUrl,
          tokenUrl: wellKnown.tokenUrl,
          scopes: wellKnown.scopes,
          callbackTransport: transport,
          redirectUri,
          requiresClientSecret,
        };
        if (wellKnown.setup) info.setup = wellKnown.setup;
        if (wellKnown.extraParams) info.extraParams = wellKnown.extraParams;

        return { content: JSON.stringify(info, null, 2), isError: false };
      }

      default:
        return { content: `Error: unknown action "${action}"`, isError: true };
    }
  }
}

export const credentialStoreTool = new CredentialStoreTool();
