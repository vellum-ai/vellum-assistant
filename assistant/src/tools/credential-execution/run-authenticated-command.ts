/**
 * CES tool: run_authenticated_command
 *
 * Delegates an authenticated command execution to the Credential Execution
 * Service. CES injects credential values into the command's environment and
 * runs it inside the CES sandbox — the assistant never sees raw secrets.
 *
 * The input schema matches the `RunAuthenticatedCommandSchema` from
 * `@vellumai/ces-contracts` exactly so the LLM-produced parameters pass
 * straight through to the CES RPC call with no transformation.
 */

import { GrantProposalSchema, renderProposal } from "@vellumai/ces-contracts";

import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import { getLogger } from "../../util/logger.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";

const log = getLogger("ces-tool:run-authenticated-command");

class RunAuthenticatedCommandTool implements Tool {
  name = "run_authenticated_command";
  description =
    "Execute a command with credential environment variables injected by CES. The command runs inside the CES sandbox — the assistant never sees raw secrets.";
  category = "credential-execution";
  defaultRiskLevel = RiskLevel.High;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          credentialHandle: {
            type: "string",
            description:
              "CES credential handle to use for environment injection (e.g. local_static:aws/key).",
          },
          command: {
            type: "string",
            description: "The command to execute.",
          },
          envMappings: {
            type: "object",
            additionalProperties: { type: "string" },
            description:
              "Optional mapping of environment variable names to credential field paths for injection.",
          },
          cwd: {
            type: "string",
            description: "Optional working directory for command execution.",
          },
          purpose: {
            type: "string",
            description:
              "Human-readable purpose for this command, shown in audit logs and approval prompts.",
          },
          inputs: {
            type: "array",
            items: {
              type: "object",
              properties: {
                workspacePath: {
                  type: "string",
                  description:
                    "Relative path within the assistant workspace to stage as a read-only input.",
                },
              },
              required: ["workspacePath"],
            },
            description:
              "Workspace files to stage as read-only inputs in the CES scratch directory before command execution.",
          },
          outputs: {
            type: "array",
            items: {
              type: "object",
              properties: {
                scratchPath: {
                  type: "string",
                  description:
                    "Relative path within the scratch directory where the command writes output.",
                },
                workspacePath: {
                  type: "string",
                  description:
                    "Relative path within the assistant workspace where the output is copied after execution.",
                },
              },
              required: ["scratchPath", "workspacePath"],
            },
            description:
              "Workspace files to copy back from the CES scratch directory after command execution.",
          },
          grantId: {
            type: "string",
            description:
              "Existing grant ID to consume, if the caller holds one from a prior approval.",
          },
        },
        required: ["credentialHandle", "command", "purpose"],
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
          "Error: CES client has not completed handshake. Cannot execute authenticated commands.",
        isError: true,
      };
    }

    const credentialHandle = input.credentialHandle as string;
    const command = input.command as string;
    const purpose = input.purpose as string;
    const envMappings = input.envMappings as Record<string, string> | undefined;
    const cwd = input.cwd as string | undefined;
    const inputs = input.inputs as Array<{ workspacePath: string }> | undefined;
    const outputs = input.outputs as
      | Array<{ scratchPath: string; workspacePath: string }>
      | undefined;
    const grantId = input.grantId as string | undefined;

    try {
      const response = await cesClient.call("run_authenticated_command", {
        credentialHandle,
        command,
        purpose,
        ...(envMappings ? { envMappings } : {}),
        ...(cwd ? { cwd } : {}),
        ...(inputs ? { inputs } : {}),
        ...(outputs ? { outputs } : {}),
        ...(grantId ? { grantId } : {}),
        conversationId: context.conversationId,
      });

      if (!response.success) {
        const errorMsg =
          response.error?.message ?? "Authenticated command failed";
        log.warn(
          { credentialHandle, command, error: errorMsg },
          "CES run_authenticated_command failed",
        );

        // Extract CES approval data from error.details when approval is required.
        // CES returns the proposal and proposalHash inside error.details, not as
        // a top-level response field.
        let cesApprovalRequired: ToolExecutionResult["cesApprovalRequired"];
        if (
          response.error?.code === "APPROVAL_REQUIRED" &&
          response.error.details
        ) {
          const details = response.error.details as Record<string, unknown>;
          const proposalParseResult = GrantProposalSchema.safeParse(
            details.proposal,
          );
          if (proposalParseResult.success) {
            const proposal = proposalParseResult.data;
            cesApprovalRequired = {
              proposal,
              proposalHash: (details.proposalHash as string) ?? "",
              renderedProposal: renderProposal(proposal),
              sessionId: context.sessionId,
            };
          } else {
            log.warn(
              {
                credentialHandle,
                command,
                parseError: proposalParseResult.error,
              },
              "CES APPROVAL_REQUIRED response has invalid proposal in error.details",
            );
          }
        }

        return {
          content: `Error: ${errorMsg}`,
          isError: true,
          cesApprovalRequired,
        };
      }

      // Build a human-readable result
      const parts: string[] = [];
      if (response.exitCode !== undefined) {
        parts.push(`Exit code: ${response.exitCode}`);
      }
      if (response.stdout) {
        parts.push(response.stdout);
      }
      if (response.stderr) {
        parts.push(`stderr:\n${response.stderr}`);
      }
      if (response.auditId) {
        parts.push(`[audit: ${response.auditId}]`);
      }

      return {
        content:
          parts.length > 0
            ? parts.join("\n\n")
            : "Command completed successfully.",
        isError: response.exitCode !== undefined && response.exitCode !== 0,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { credentialHandle, command, error: msg },
        "CES run_authenticated_command RPC error",
      );
      return {
        content: `Error: CES RPC call failed — ${msg}`,
        isError: true,
      };
    }
  }
}

export const runAuthenticatedCommandTool = new RunAuthenticatedCommandTool();
