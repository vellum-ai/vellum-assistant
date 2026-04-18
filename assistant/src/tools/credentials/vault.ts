import { getConfig } from "../../config/loader.js";
import {
  clearSlackUserToken,
  setSlackChannelConfig,
  type SlackChannelConfigResult,
} from "../../daemon/handlers/config-slack-channel.js";
import { syncManualTokenConnection } from "../../oauth/manual-token-connection.js";
import {
  disconnectOAuthProvider,
  getActiveConnection,
} from "../../oauth/oauth-store.js";
import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import { credentialKey } from "../../security/credential-key.js";
import {
  deleteSecureKeyAsync,
  listSecureKeysAsync,
  setSecureKeyAsync,
} from "../../security/secure-keys.js";
import { getLogger } from "../../util/logger.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";
import { credentialBroker } from "./broker.js";
import {
  assertMetadataWritable,
  deleteCredentialMetadata,
  getCredentialMetadata,
  listCredentialMetadata,
  upsertCredentialMetadata,
} from "./metadata-store.js";
import type {
  CredentialInjectionTemplate,
  CredentialPolicyInput,
} from "./policy-types.js";
import { toPolicyFromInput, validatePolicyInput } from "./policy-validate.js";

const log = getLogger("credential-vault");

function isSlackChannelCredential(
  service: string,
  field: string,
): field is "bot_token" | "app_token" | "user_token" {
  return (
    service === "slack_channel" &&
    (field === "bot_token" || field === "app_token" || field === "user_token")
  );
}

async function storeSlackChannelCredential(
  field: "bot_token" | "app_token" | "user_token",
  value: string,
): Promise<SlackChannelConfigResult> {
  if (field === "bot_token") {
    return setSlackChannelConfig(value, undefined);
  }
  if (field === "app_token") {
    return setSlackChannelConfig(undefined, value);
  }
  return setSlackChannelConfig(undefined, undefined, value);
}

function formatSlackChannelStatus(result: SlackChannelConfigResult): string {
  if (result.connected) {
    const teamLabel = result.teamName ?? "Slack";
    const botLabel = result.botUsername ? ` (@${result.botUsername})` : "";
    return ` Slack channel connected to ${teamLabel}${botLabel}.`;
  }
  if (result.warning) {
    return ` ${result.warning}`;
  }
  return "";
}

class CredentialStoreTool implements Tool {
  name = "credential_store";
  description =
    "Store, list, delete, or prompt for credentials in the secure vault";
  category = "credentials";
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["store", "list", "delete", "prompt"],
            description:
              'The operation to perform. Use "prompt" to ask the user for a secret via secure UI - the value never enters the conversation.',
          },
          service: {
            type: "string",
            description: "Service name, e.g. google, github",
          },
          account: {
            type: "string",
            description:
              "Account identifier (e.g. email address) to target a specific connection when multiple accounts are connected for the same service. If omitted, uses the most recently connected account.",
          },
          field: {
            type: "string",
            description: "Field name, e.g. password, username, recovery_email",
          },
          value: {
            type: "string",
            description: "The credential value (only for store action)",
          },
          label: {
            type: "string",
            description:
              'Display label for the prompt UI (only for prompt action), e.g. "GitHub Personal Access Token"',
          },
          description: {
            type: "string",
            description:
              'Optional context shown in the prompt UI (only for prompt action), e.g. "Needed to push changes"',
          },
          placeholder: {
            type: "string",
            description:
              'Placeholder text for the input field (only for prompt action), e.g. "ghp_xxxxxxxxxxxx"',
          },
          allowed_tools: {
            type: "array",
            items: { type: "string" },
            description:
              'Tools/capabilities allowed to use this credential (for store/prompt actions), e.g. ["assistant_browser_fill_credential"]. Empty = deny all.',
          },
          allowed_domains: {
            type: "array",
            items: { type: "string" },
            description:
              'Domains where this credential may be used (for store/prompt actions), e.g. ["github.com"]. Empty = deny all.',
          },
          usage_description: {
            type: "string",
            description:
              'Human-readable description of intended usage (for store/prompt actions), e.g. "GitHub login for pushing changes"',
          },
          alias: {
            type: "string",
            description:
              'Human-friendly name for this credential (only for store action), e.g. "fal-primary"',
          },
          injection_templates: {
            type: "array",
            items: {
              type: "object",
              properties: {
                hostPattern: {
                  type: "string",
                  description:
                    'Glob pattern for matching request hosts, e.g. "*.fal.ai"',
                },
                injectionType: {
                  type: "string",
                  enum: ["header", "query"],
                  description: "Where to inject the credential value",
                },
                headerName: {
                  type: "string",
                  description: 'Header name when injectionType is "header"',
                },
                valuePrefix: {
                  type: "string",
                  description:
                    'Prefix prepended to the secret value, e.g. "Key ", "Bearer "',
                },
                queryParamName: {
                  type: "string",
                  description:
                    'Query parameter name when injectionType is "query"',
                },
              },
              required: ["hostPattern", "injectionType"],
            },
            description:
              "Templates describing how to inject this credential into proxied requests (for store and prompt actions)",
          },
        },
        required: ["action"],
      },
    };
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const action = input.action as string;

    switch (action) {
      case "store": {
        const service = input.service as string | undefined;
        const field = input.field as string | undefined;
        const value = input.value as string | undefined;

        if (!service || typeof service !== "string") {
          return {
            content: "Error: service is required for store action",
            isError: true,
          };
        }
        if (!field || typeof field !== "string") {
          return {
            content: "Error: field is required for store action",
            isError: true,
          };
        }
        if (!value || typeof value !== "string") {
          return {
            content: "Error: value is required for store action",
            isError: true,
          };
        }

        const policyInput: CredentialPolicyInput = {
          allowed_tools: input.allowed_tools as string[] | undefined,
          allowed_domains: input.allowed_domains as string[] | undefined,
          usage_description: input.usage_description as string | undefined,
        };
        const policyResult = validatePolicyInput(policyInput);
        if (!policyResult.valid) {
          return {
            content: `Error: ${policyResult.errors.join("; ")}`,
            isError: true,
          };
        }
        const policy = toPolicyFromInput(policyInput);

        const alias = input.alias;
        if (alias !== undefined && typeof alias !== "string") {
          return { content: "Error: alias must be a string", isError: true };
        }
        const rawTemplates = input.injection_templates as unknown[] | undefined;

        // Validate injection templates
        let injectionTemplates: CredentialInjectionTemplate[] | undefined;
        if (rawTemplates !== undefined) {
          if (!Array.isArray(rawTemplates)) {
            return {
              content: "Error: injection_templates must be an array",
              isError: true,
            };
          }
          const templateErrors: string[] = [];
          injectionTemplates = [];
          for (let i = 0; i < rawTemplates.length; i++) {
            const t = rawTemplates[i] as Record<string, unknown>;
            if (typeof t !== "object" || t == null) {
              templateErrors.push(
                `injection_templates[${i}] must be an object`,
              );
              continue;
            }
            if (
              typeof t.hostPattern !== "string" ||
              t.hostPattern.trim().length === 0
            ) {
              templateErrors.push(
                `injection_templates[${i}].hostPattern must be a non-empty string`,
              );
            }
            if (t.injectionType !== "header" && t.injectionType !== "query") {
              templateErrors.push(
                `injection_templates[${i}].injectionType must be 'header' or 'query'`,
              );
            } else if (t.injectionType === "header") {
              if (
                typeof t.headerName !== "string" ||
                t.headerName.trim().length === 0
              ) {
                templateErrors.push(
                  `injection_templates[${i}].headerName is required when injectionType is 'header'`,
                );
              }
            } else if (t.injectionType === "query") {
              if (
                typeof t.queryParamName !== "string" ||
                t.queryParamName.trim().length === 0
              ) {
                templateErrors.push(
                  `injection_templates[${i}].queryParamName is required when injectionType is 'query'`,
                );
              }
            }
            if (
              t.valuePrefix !== undefined &&
              typeof t.valuePrefix !== "string"
            ) {
              templateErrors.push(
                `injection_templates[${i}].valuePrefix must be a string`,
              );
            }
            if (templateErrors.length === 0) {
              injectionTemplates.push({
                hostPattern: t.hostPattern as string,
                injectionType: t.injectionType as "header" | "query",
                headerName:
                  typeof t.headerName === "string" ? t.headerName : undefined,
                valuePrefix:
                  typeof t.valuePrefix === "string" ? t.valuePrefix : undefined,
                queryParamName:
                  typeof t.queryParamName === "string"
                    ? t.queryParamName
                    : undefined,
              });
            }
          }
          if (templateErrors.length > 0) {
            return {
              content: `Error: ${templateErrors.join("; ")}`,
              isError: true,
            };
          }
        }

        try {
          assertMetadataWritable();
        } catch {
          return {
            content:
              "Error: credential metadata file has an unrecognized version; cannot store credentials",
            isError: true,
          };
        }

        let slackChannelResult: SlackChannelConfigResult | undefined;
        if (isSlackChannelCredential(service, field)) {
          slackChannelResult = await storeSlackChannelCredential(field, value);
          if (!slackChannelResult.success) {
            return {
              content: `Error: ${
                slackChannelResult.error ?? "failed to configure Slack channel"
              }`,
              isError: true,
            };
          }
        } else {
          const key = credentialKey(service, field);
          const ok = await setSecureKeyAsync(key, value);
          if (!ok) {
            return {
              content: "Error: failed to store credential",
              isError: true,
            };
          }
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
          log.warn(
            { service, field, err },
            "metadata write failed after storing credential",
          );
        }
        if (!isSlackChannelCredential(service, field)) {
          await syncManualTokenConnection(service);
        }
        const metadata = getCredentialMetadata(service, field);
        const credIdSuffix = metadata
          ? ` (credential_id: ${metadata.credentialId})`
          : "";
        const retrieveHint = ` Retrieve with: \`assistant credentials reveal --service ${service} --field ${field}\``;
        return {
          content: `Stored credential for ${service}/${field}.${credIdSuffix}${retrieveHint}${
            slackChannelResult
              ? formatSlackChannelStatus(slackChannelResult)
              : ""
          }`,
          isError: false,
        };
      }

      case "list": {
        try {
          assertMetadataWritable();
        } catch {
          return {
            content:
              "Error: credential metadata file has an unrecognized version; cannot list credentials",
            isError: true,
          };
        }

        const allMetadata = listCredentialMetadata();
        // Verify secrets still exist by reading all key names once (instead of
        // per-entry getSecureKeyAsync calls that each re-read/re-derive the store).
        // Uses the async variant to include keys from the credential store.
        let secureKeySet: Set<string> | undefined;
        try {
          secureKeySet = new Set((await listSecureKeysAsync()).accounts);
        } catch (err) {
          log.error(
            { err },
            "Failed to read secure store while listing credentials",
          );
          return {
            content:
              "Error: failed to read secure storage; cannot list credentials",
            isError: true,
          };
        }
        const entries = allMetadata
          .filter((m) => {
            if (secureKeySet)
              return secureKeySet.has(credentialKey(m.service, m.field));
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

      case "delete": {
        const service = input.service as string | undefined;
        const field = input.field as string | undefined;

        if (!service || typeof service !== "string") {
          return {
            content: "Error: service is required for delete action",
            isError: true,
          };
        }
        if (!field || typeof field !== "string") {
          return {
            content: "Error: field is required for delete action",
            isError: true,
          };
        }

        try {
          assertMetadataWritable();
        } catch {
          return {
            content:
              "Error: credential metadata file has an unrecognized version; cannot delete credentials",
            isError: true,
          };
        }

        // Surgical delete for the Slack user_token: it grants read-only access
        // to channels the bot isn't a member of, but the Socket Mode connection
        // is powered by the bot + app tokens. Tearing down the oauth_connection
        // row when only user_token is removed would flap the integration's
        // connected state until the next sync. Keep bot+app teardown behavior
        // unchanged — those tokens are what the connection depends on.
        if (service === "slack_channel" && field === "user_token") {
          const slackResult = await clearSlackUserToken();
          if (!slackResult.success) {
            return {
              content: `Error: ${
                slackResult.error ?? "failed to delete Slack user token"
              }`,
              isError: true,
            };
          }
          return {
            content: `Deleted credential for ${service}/${field}.`,
            isError: false,
          };
        }

        const key = credentialKey(service, field);
        const result = await deleteSecureKeyAsync(key);
        if (result === "error") {
          return {
            content: `Error: failed to delete credential ${service}/${field} from secure storage`,
            isError: true,
          };
        }
        if (result === "not-found") {
          return {
            content: `Error: credential ${service}/${field} not found`,
            isError: true,
          };
        }
        try {
          deleteCredentialMetadata(service, field);
        } catch (err) {
          log.warn(
            { service, field, err },
            "metadata delete failed after removing credential",
          );
        }
        // Also clean up any OAuth connection for this service (best-effort)
        try {
          const accountHint = input.account as string | undefined;
          let oauthResult: "disconnected" | "not-found" | "error";
          if (accountHint) {
            const targetConn = getActiveConnection(service, {
              account: accountHint,
            });
            oauthResult = targetConn
              ? await disconnectOAuthProvider(service, undefined, targetConn.id)
              : "not-found";
          } else {
            oauthResult = await disconnectOAuthProvider(service);
          }
          if (oauthResult === "error") {
            log.warn(
              { service },
              "OAuth disconnect failed after removing credential - secure key deletion error",
            );
          }
        } catch (err) {
          log.warn(
            { service, err },
            "OAuth disconnect failed after removing credential",
          );
        }
        return {
          content: `Deleted credential for ${service}/${field}.`,
          isError: false,
        };
      }

      case "prompt": {
        const service = input.service as string | undefined;
        const field = input.field as string | undefined;

        if (!service || typeof service !== "string") {
          return {
            content: "Error: service is required for prompt action",
            isError: true,
          };
        }
        if (!field || typeof field !== "string") {
          return {
            content: "Error: field is required for prompt action",
            isError: true,
          };
        }

        if (!context.requestSecret) {
          return {
            content: "Error: secret prompting not available in this context",
            isError: true,
          };
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
          return {
            content: `Error: ${promptPolicyResult.errors.join("; ")}`,
            isError: true,
          };
        }
        const promptPolicy = toPolicyFromInput(promptPolicyInput);

        // Parse and validate injection templates (same logic as store action)
        const promptRawTemplates = input.injection_templates as
          | unknown[]
          | undefined;
        let promptInjectionTemplates: CredentialInjectionTemplate[] | undefined;
        if (promptRawTemplates !== undefined) {
          if (!Array.isArray(promptRawTemplates)) {
            return {
              content: "Error: injection_templates must be an array",
              isError: true,
            };
          }
          const promptTemplateErrors: string[] = [];
          promptInjectionTemplates = [];
          for (let i = 0; i < promptRawTemplates.length; i++) {
            const t = promptRawTemplates[i] as Record<string, unknown>;
            if (typeof t !== "object" || t == null) {
              promptTemplateErrors.push(
                `injection_templates[${i}] must be an object`,
              );
              continue;
            }
            if (
              typeof t.hostPattern !== "string" ||
              t.hostPattern.trim().length === 0
            ) {
              promptTemplateErrors.push(
                `injection_templates[${i}].hostPattern must be a non-empty string`,
              );
            }
            if (t.injectionType !== "header" && t.injectionType !== "query") {
              promptTemplateErrors.push(
                `injection_templates[${i}].injectionType must be 'header' or 'query'`,
              );
            } else if (t.injectionType === "header") {
              if (
                typeof t.headerName !== "string" ||
                t.headerName.trim().length === 0
              ) {
                promptTemplateErrors.push(
                  `injection_templates[${i}].headerName is required when injectionType is 'header'`,
                );
              }
            } else if (t.injectionType === "query") {
              if (
                typeof t.queryParamName !== "string" ||
                t.queryParamName.trim().length === 0
              ) {
                promptTemplateErrors.push(
                  `injection_templates[${i}].queryParamName is required when injectionType is 'query'`,
                );
              }
            }
            if (
              t.valuePrefix !== undefined &&
              typeof t.valuePrefix !== "string"
            ) {
              promptTemplateErrors.push(
                `injection_templates[${i}].valuePrefix must be a string`,
              );
            }
            if (promptTemplateErrors.length === 0) {
              promptInjectionTemplates.push({
                hostPattern: t.hostPattern as string,
                injectionType: t.injectionType as "header" | "query",
                headerName:
                  typeof t.headerName === "string" ? t.headerName : undefined,
                valuePrefix:
                  typeof t.valuePrefix === "string" ? t.valuePrefix : undefined,
                queryParamName:
                  typeof t.queryParamName === "string"
                    ? t.queryParamName
                    : undefined,
              });
            }
          }
          if (promptTemplateErrors.length > 0) {
            return {
              content: `Error: ${promptTemplateErrors.join("; ")}`,
              isError: true,
            };
          }
        }

        try {
          assertMetadataWritable();
        } catch {
          return {
            content:
              "Error: credential metadata file has an unrecognized version; cannot store credentials",
            isError: true,
          };
        }

        const result = await context.requestSecret({
          service,
          field,
          label,
          description,
          placeholder,
          purpose: promptPolicy.usageDescription,
          allowedTools:
            promptPolicy.allowedTools.length > 0
              ? promptPolicy.allowedTools
              : undefined,
          allowedDomains:
            promptPolicy.allowedDomains.length > 0
              ? promptPolicy.allowedDomains
              : undefined,
        });
        if (!result.value) {
          return {
            content: "User cancelled the credential prompt.",
            isError: false,
          };
        }

        // Handle one-time send delivery: inject into context without persisting
        if (result.delivery === "transient_send") {
          if (isSlackChannelCredential(service, field)) {
            return {
              content:
                "Error: Slack channel credentials must be saved to secure storage. Re-run the secure prompt and choose to store the token.",
              isError: true,
            };
          }
          const config = getConfig();
          if (!config.secretDetection.allowOneTimeSend) {
            log.warn(
              { service, field },
              "One-time send requested but not enabled in config",
            );
            return {
              content:
                "Error: one-time send is not enabled. Set secretDetection.allowOneTimeSend to true in config.",
              isError: true,
            };
          }
          // Ensure metadata exists so broker policy checks work, but don't
          // overwrite an existing record - a stored credential's policy should
          // not be silently replaced by the transient prompt's policy.
          // Metadata must be written before injecting the transient value so
          // we never leave a dangling value that fails policy checks.
          if (!getCredentialMetadata(service, field)) {
            try {
              upsertCredentialMetadata(service, field, {
                allowedTools: promptPolicy.allowedTools,
                allowedDomains: promptPolicy.allowedDomains,
                usageDescription: promptPolicy.usageDescription,
                injectionTemplates: promptInjectionTemplates,
              });
            } catch (err) {
              // Without metadata the broker's policy checks will reject usage,
              // so the transient value would be silently unusable. Fail loudly.
              log.error(
                { service, field, err },
                "metadata write failed for transient credential",
              );
              return {
                content: `Error: failed to write credential metadata for ${service}/${field}; the one-time value was discarded.`,
                isError: true,
              };
            }
          }
          // Inject into broker for one-time use by the next tool call, then discard
          credentialBroker.injectTransient(service, field, result.value);
          log.info(
            { service, field, delivery: "transient_send" },
            "One-time secret delivery used",
          );
          return {
            content: `One-time credential provided for ${service}/${field}. The value was NOT saved to the vault and will be consumed by the next operation.`,
            isError: false,
          };
        }

        let slackChannelResult: SlackChannelConfigResult | undefined;
        if (isSlackChannelCredential(service, field)) {
          slackChannelResult = await storeSlackChannelCredential(
            field,
            result.value,
          );
          if (!slackChannelResult.success) {
            return {
              content: `Error: ${
                slackChannelResult.error ?? "failed to configure Slack channel"
              }`,
              isError: true,
            };
          }
        } else {
          // Default: persist to credential store
          const key = credentialKey(service, field);
          const ok = await setSecureKeyAsync(key, result.value);
          if (!ok) {
            return {
              content: "Error: failed to store credential",
              isError: true,
            };
          }
        }
        try {
          upsertCredentialMetadata(service, field, {
            allowedTools: promptPolicy.allowedTools,
            allowedDomains: promptPolicy.allowedDomains,
            usageDescription: promptPolicy.usageDescription,
            injectionTemplates: promptInjectionTemplates,
          });
        } catch (err) {
          log.warn(
            { service, field, err },
            "metadata write failed after storing credential",
          );
        }
        if (!isSlackChannelCredential(service, field)) {
          await syncManualTokenConnection(service);
        }
        const promptMeta = getCredentialMetadata(service, field);
        const promptCredIdSuffix = promptMeta
          ? ` (credential_id: ${promptMeta.credentialId})`
          : "";
        const promptRetrieveHint = ` Retrieve with: \`assistant credentials reveal --service ${service} --field ${field}\``;
        return {
          content: `Credential stored for ${service}/${field}.${promptCredIdSuffix}${promptRetrieveHint}${
            slackChannelResult
              ? formatSlackChannelStatus(slackChannelResult)
              : ""
          }`,
          isError: false,
        };
      }

      default:
        return { content: `Error: unknown action "${action}"`, isError: true };
    }
  }
}

export const credentialStoreTool = new CredentialStoreTool();
