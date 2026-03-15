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
          profiles: {
            type: "array",
            items: { type: "string" },
            description:
              'Declared credential profiles the bundle requires (e.g. ["aws", "github"]). Shown to the guardian during approval.',
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

      const missing: string[] = [];
      if (!bundleId) missing.push("bundleId");
      if (!version) missing.push("version");
      if (!sourceUrl) missing.push("sourceUrl");
      if (!sha256) missing.push("sha256");
      if (!credentialHandle) missing.push("credentialHandle");

      if (missing.length > 0) {
        return {
          content: `Error: register action requires: ${missing.join(", ")}`,
          isError: true,
        };
      }

      // Reject non-HTTPS source URLs to prevent insecure downloads
      if (sourceUrl && !sourceUrl.startsWith("https://")) {
        return {
          content:
            "Error: sourceUrl must use HTTPS for secure bundle downloads.",
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
              ...(input.profiles
                ? { profiles: input.profiles as string[] }
                : {}),
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
