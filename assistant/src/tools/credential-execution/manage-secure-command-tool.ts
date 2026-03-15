/**
 * CES tool: manage_secure_command_tool
 *
 * The only assistant-facing way to request secure bundle installation or
 * update. This tool deliberately accepts only user-reviewable bundle
 * metadata (bundleId, version, sourceUrl, sha256, declared profiles) —
 * never raw bytes, workspace file paths, or executable content.
 *
 * Every invocation forces a fresh approval prompt without creating
 * persistent grants, so the guardian reviews each installation request
 * individually.
 *
 * The tool translates the bundle metadata into the CES
 * `manage_secure_command_tool` RPC, which handles download, integrity
 * verification, and installation inside the CES sandbox.
 */

import type { ManageSecureCommandTool } from "@vellumai/ces-contracts/rpc";

import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import { getLogger } from "../../util/logger.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";

const log = getLogger("ces-tool:manage-secure-command-tool");

class ManageSecureCommandToolImpl implements Tool {
  name = "manage_secure_command_tool";
  description =
    "Request installation, update, or removal of a secure command tool bundle. " +
    "Accepts only bundle metadata for guardian review — never raw bytes or file paths. " +
    "Each invocation requires fresh approval.";
  category = "credential-execution";
  defaultRiskLevel = RiskLevel.High;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["register", "unregister"],
            description:
              'Whether to install/update ("register") or remove ("unregister") the secure command tool.',
          },
          toolName: {
            type: "string",
            description:
              "Unique tool name for the secure command (e.g. aws-cli, kubectl).",
          },
          bundleId: {
            type: "string",
            description:
              "Bundle identifier for the secure command package (required for register).",
          },
          version: {
            type: "string",
            description:
              "Semantic version of the bundle to install (required for register).",
          },
          sourceUrl: {
            type: "string",
            description:
              "URL from which CES will download the bundle (required for register). Must be HTTPS.",
          },
          sha256: {
            type: "string",
            description:
              "SHA-256 hash of the bundle for integrity verification (required for register).",
          },
          credentialHandle: {
            type: "string",
            description:
              "CES credential handle the tool should use (required for register).",
          },
          description: {
            type: "string",
            description:
              "Human-readable description of what the secure command tool does (required for register).",
          },
          secureCommandManifest: {
            type: "object",
            description:
              "Full secure command manifest for the bundle (required for register). " +
              "Contains entrypoint, command profiles, auth adapter, egress mode, etc. " +
              "CES validates this manifest before publishing the bundle.",
            properties: {
              schemaVersion: {
                type: "string",
                description: 'Manifest schema version. Must be "1".',
              },
              bundleDigest: {
                type: "string",
                description: "SHA-256 hex digest of the command bundle.",
              },
              bundleId: {
                type: "string",
                description: "Unique identifier for the command bundle.",
              },
              version: {
                type: "string",
                description: "Semantic version of the bundle.",
              },
              entrypoint: {
                type: "string",
                description:
                  'Path to the executable entrypoint within the bundle (e.g. "bin/gh").',
              },
              commandProfiles: {
                type: "object",
                description:
                  "Named command profiles. Each profile defines a narrow execution boundary.",
                additionalProperties: {
                  type: "object",
                  properties: {
                    description: { type: "string" },
                    allowedArgvPatterns: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          name: { type: "string" },
                          tokens: {
                            type: "array",
                            items: { type: "string" },
                          },
                        },
                        required: ["name", "tokens"],
                      },
                    },
                    deniedSubcommands: {
                      type: "array",
                      items: { type: "string" },
                    },
                    deniedFlags: {
                      type: "array",
                      items: { type: "string" },
                    },
                    allowedNetworkTargets: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          hostPattern: { type: "string" },
                          ports: {
                            type: "array",
                            items: { type: "number" },
                          },
                          protocols: {
                            type: "array",
                            items: { type: "string" },
                          },
                        },
                        required: ["hostPattern"],
                      },
                    },
                  },
                  required: [
                    "description",
                    "allowedArgvPatterns",
                    "deniedSubcommands",
                  ],
                },
              },
              authAdapter: {
                type: "object",
                description:
                  "Auth adapter configuration describing how credentials are injected. " +
                  "Use type=env_var to set an environment variable, type=temp_file to write " +
                  "credentials to a temporary file, or type=credential_process to run a helper command.",
                properties: {
                  type: {
                    type: "string",
                    enum: ["env_var", "temp_file", "credential_process"],
                    description:
                      "Adapter type: env_var, temp_file, or credential_process.",
                  },
                  envVarName: {
                    type: "string",
                    description:
                      "Environment variable name for credential injection (required for all types).",
                  },
                  valuePrefix: {
                    type: "string",
                    description:
                      'Optional prefix prepended to the credential value (env_var only, e.g. "Bearer ").',
                  },
                  fileExtension: {
                    type: "string",
                    description:
                      'Optional file extension for the temp file (temp_file only, e.g. ".json").',
                  },
                  fileMode: {
                    type: "number",
                    description:
                      "Optional file mode/permissions for the temp file (temp_file only, e.g. 0o600).",
                  },
                  helperCommand: {
                    type: "string",
                    description:
                      "Command to run to obtain credentials (credential_process only, required for that type).",
                  },
                  timeoutMs: {
                    type: "number",
                    description:
                      "Timeout in milliseconds for the helper command (credential_process only).",
                  },
                },
                required: ["type", "envVarName"],
              },
              egressMode: {
                type: "string",
                enum: ["proxy_required", "no_network"],
                description: "Network egress enforcement mode.",
              },
              cleanConfigDirs: {
                type: "object",
                description:
                  "Config directories to mount as empty tmpfs during execution.",
                additionalProperties: { type: "string" },
              },
            },
            required: [
              "schemaVersion",
              "bundleDigest",
              "bundleId",
              "version",
              "entrypoint",
              "commandProfiles",
              "authAdapter",
              "egressMode",
            ],
          },
        },
        required: ["action", "toolName"],
      },
    };
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const cesClient = context.cesClient;
    if (!cesClient) {
      return {
        content:
          "Error: CES client is not available. The Credential Execution Service must be running.",
        isError: true,
      };
    }

    if (!cesClient.isReady()) {
      return {
        content:
          "Error: CES client has not completed handshake. Cannot manage secure command tools.",
        isError: true,
      };
    }

    const action = input.action as "register" | "unregister";
    const toolName = input.toolName as string;

    // Validate that register actions include the required bundle metadata
    if (action === "register") {
      const bundleId = input.bundleId as string | undefined;
      const version = input.version as string | undefined;
      const sourceUrl = input.sourceUrl as string | undefined;
      const sha256 = input.sha256 as string | undefined;
      const credentialHandle = input.credentialHandle as string | undefined;
      const description = input.description as string | undefined;
      const secureCommandManifest = input.secureCommandManifest as
        | Record<string, unknown>
        | undefined;

      const missing: string[] = [];
      if (!bundleId) missing.push("bundleId");
      if (!version) missing.push("version");
      if (!sourceUrl) missing.push("sourceUrl");
      if (!sha256) missing.push("sha256");
      if (!credentialHandle) missing.push("credentialHandle");
      if (!description) missing.push("description");
      if (!secureCommandManifest) missing.push("secureCommandManifest");

      if (missing.length > 0) {
        return {
          content: `Error: register action requires: ${missing.join(", ")}`,
          isError: true,
        };
      }

      // Reject non-HTTPS source URLs to prevent insecure downloads
      try {
        const parsed = new URL(sourceUrl!);
        if (parsed.protocol !== "https:") {
          return {
            content:
              "Error: sourceUrl must use HTTPS for secure bundle downloads.",
            isError: true,
          };
        }
      } catch {
        return {
          content: "Error: sourceUrl is not a valid URL.",
          isError: true,
        };
      }
    }

    // Build the CES RPC request. Bundle metadata fields are sent directly
    // as proper schema fields on the RPC payload.
    try {
      const response = await cesClient.call("manage_secure_command_tool", {
        action,
        toolName,
        ...(input.credentialHandle
          ? { credentialHandle: input.credentialHandle as string }
          : {}),
        ...(input.description
          ? { description: input.description as string }
          : {}),
        ...(action === "register"
          ? {
              bundleId: input.bundleId as string,
              version: input.version as string,
              sourceUrl: input.sourceUrl as string,
              sha256: input.sha256 as string,
              secureCommandManifest:
                input.secureCommandManifest as ManageSecureCommandTool["secureCommandManifest"],
            }
          : {}),
      });

      if (!response.success) {
        const errorMsg =
          response.error?.message ?? `Failed to ${action} secure command tool`;
        log.warn(
          { toolName, action, error: errorMsg },
          "CES manage_secure_command_tool failed",
        );
        return { content: `Error: ${errorMsg}`, isError: true };
      }

      if (action === "register") {
        return {
          content: `Secure command tool "${toolName}" registered successfully (bundle: ${input.bundleId}@${input.version}).`,
          isError: false,
        };
      }

      return {
        content: `Secure command tool "${toolName}" unregistered successfully.`,
        isError: false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { toolName, action, error: msg },
        "CES manage_secure_command_tool RPC error",
      );
      return {
        content: `Error: CES RPC call failed — ${msg}`,
        isError: true,
      };
    }
  }
}

export const manageSecureCommandTool = new ManageSecureCommandToolImpl();
