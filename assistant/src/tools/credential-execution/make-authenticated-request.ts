/**
 * CES tool: make_authenticated_request
 *
 * Delegates an authenticated HTTP request to the Credential Execution Service.
 * The assistant never sees raw credentials — CES injects the credential into
 * the outbound request internally and returns the sanitised response.
 *
 * The input schema matches the `MakeAuthenticatedRequestSchema` from
 * `@vellumai/ces-contracts` exactly so the LLM-produced parameters pass
 * straight through to the CES RPC call with no transformation.
 */

import { GrantProposalSchema, renderProposal } from "@vellumai/ces-contracts";

import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import { getLogger } from "../../util/logger.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";

const log = getLogger("ces-tool:make-authenticated-request");

class MakeAuthenticatedRequestTool implements Tool {
  name = "make_authenticated_request";
  description =
    "Execute an authenticated HTTP request through CES. CES injects the credential and returns the response — the assistant never sees raw secrets.";
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
              "CES credential handle to use for authentication (e.g. local_static:github/api_key).",
          },
          method: {
            type: "string",
            description: "HTTP method (GET, POST, PUT, DELETE, PATCH, etc.).",
          },
          url: {
            type: "string",
            description: "Target URL for the request.",
          },
          headers: {
            type: "object",
            additionalProperties: { type: "string" },
            description:
              "Optional request headers. Credential headers are injected by CES — do not include secrets here.",
          },
          body: {
            description:
              "Optional request body (string or JSON-serialisable object).",
          },
          purpose: {
            type: "string",
            description:
              "Human-readable purpose for this request, shown in audit logs and approval prompts.",
          },
          grantId: {
            type: "string",
            description:
              "Existing grant ID to consume, if the caller holds one from a prior approval.",
          },
        },
        required: ["credentialHandle", "method", "url", "purpose"],
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
          "Error: CES client has not completed handshake. Cannot execute authenticated requests.",
        isError: true,
      };
    }

    const credentialHandle = input.credentialHandle as string;
    const method = input.method as string;
    const url = input.url as string;
    const purpose = input.purpose as string;
    const headers = input.headers as Record<string, string> | undefined;
    const body = input.body;
    const grantId = input.grantId as string | undefined;

    try {
      const response = await cesClient.call("make_authenticated_request", {
        credentialHandle,
        method,
        url,
        purpose,
        ...(headers ? { headers } : {}),
        ...(body !== undefined ? { body } : {}),
        ...(grantId ? { grantId } : {}),
      });

      if (!response.success) {
        const errorMsg =
          response.error?.message ?? "Authenticated request failed";
        log.warn(
          { credentialHandle, method, url, error: errorMsg },
          "CES make_authenticated_request failed",
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
                method,
                url,
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
      if (response.statusCode !== undefined) {
        parts.push(`HTTP ${response.statusCode}`);
      }
      if (response.responseBody) {
        parts.push(response.responseBody);
      }
      if (response.auditId) {
        parts.push(`[audit: ${response.auditId}]`);
      }

      return {
        content:
          parts.length > 0
            ? parts.join("\n\n")
            : "Request completed successfully.",
        isError: false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { credentialHandle, method, url, error: msg },
        "CES make_authenticated_request RPC error",
      );
      return {
        content: `Error: CES RPC call failed — ${msg}`,
        isError: true,
      };
    }
  }
}

export const makeAuthenticatedRequestTool = new MakeAuthenticatedRequestTool();
