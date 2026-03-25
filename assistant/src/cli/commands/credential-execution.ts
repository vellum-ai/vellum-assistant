/**
 * CLI surfaces for CES grant listing, grant revocation, and audit inspection.
 *
 * These commands communicate with the Credential Execution Service via
 * the CES RPC client to inspect and manage CES-owned state. They never
 * expose raw secrets, raw tokens, or raw headers/bodies — only sanitized
 * metadata and audit summaries.
 *
 * Commands:
 * - `credential-execution grants list` — List current CES grants.
 * - `credential-execution grants revoke <id>` — Revoke a grant by stable ID.
 * - `credential-execution audit list` — List recent audit records.
 */

import {
  type AuditRecordSummary,
  CesRpcMethod,
  type ListAuditRecordsResponse,
  type ListGrantsResponse,
  type PersistentGrantRecord,
  type RevokeGrantResponse,
} from "@vellumai/ces-contracts";
import type { Command } from "commander";

import { getConfig } from "../../config/loader.js";
import {
  type CesClient,
  createCesClient,
} from "../../credential-execution/client.js";
import { isCesGrantAuditEnabled } from "../../credential-execution/feature-gates.js";
import { createCesProcessManager } from "../../credential-execution/process-manager.js";
import { log } from "../logger.js";
import { shouldOutputJson, writeOutput } from "../output.js";

// ---------------------------------------------------------------------------
// Runtime feature gate
// ---------------------------------------------------------------------------

/**
 * Check the ces-grant-audit feature flag and bail with a clear message if
 * disabled. Returns `true` when the gate is open, `false` (with output
 * written) when the feature is off.
 */
function ensureGrantAuditEnabled(cmd: Command): boolean {
  if (isCesGrantAuditEnabled(getConfig())) return true;

  writeOutput(cmd, {
    ok: false,
    error: "CES grant/audit inspection is disabled (ces-grant-audit is off)",
  });
  process.exitCode = 1;
  return false;
}

// ---------------------------------------------------------------------------
// CES client lifecycle helpers
// ---------------------------------------------------------------------------

/**
 * Spin up a CES process (or connect to the sidecar), perform the handshake,
 * and return a ready client. The caller must call `cleanup()` when done.
 */
async function acquireCesClient(): Promise<{
  client: CesClient;
  cleanup: () => Promise<void>;
}> {
  const pm = createCesProcessManager({ assistantConfig: getConfig() });
  const transport = await pm.start();
  const client = createCesClient(transport);

  try {
    const hs = await client.handshake();

    if (!hs.accepted) {
      throw new Error(`CES handshake rejected: ${hs.reason ?? "unknown"}`);
    }
  } catch (err) {
    client.close();
    await pm.stop();
    throw err;
  }

  return {
    client,
    cleanup: async () => {
      client.close();
      await pm.stop();
    },
  };
}

// ---------------------------------------------------------------------------
// Human-readable formatters
// ---------------------------------------------------------------------------

function printGrantHuman(grant: PersistentGrantRecord): void {
  log.info(`  Grant ${grant.grantId}`);
  log.info(`    Handle:       ${grant.credentialHandle}`);
  log.info(`    Type:         ${grant.proposalType}`);
  log.info(`    Status:       ${grant.status}`);
  log.info(`    Granted by:   ${grant.grantedBy}`);
  log.info(`    Created:      ${grant.createdAt}`);
  if (grant.expiresAt) log.info(`    Expires:      ${grant.expiresAt}`);
  if (grant.allowedPurposes.length > 0) {
    log.info(`    Purposes:     ${grant.allowedPurposes.join(", ")}`);
  }
}

function printAuditRecordHuman(record: AuditRecordSummary): void {
  log.info(`  ${record.timestamp}  ${record.toolName}  ${record.target}`);
  log.info(`    Audit ID:     ${record.auditId}`);
  log.info(`    Grant:        ${record.grantId}`);
  log.info(`    Handle:       ${record.credentialHandle}`);
  log.info(`    Success:      ${record.success}`);
  if (record.errorMessage) {
    log.info(`    Error:        ${record.errorMessage}`);
  }
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerCredentialExecutionCommand(program: Command): void {
  const ce = program
    .command("credential-execution")
    .description(
      "Inspect and manage Credential Execution Service (CES) grants and audit records",
    )
    .option("--json", "Machine-readable compact JSON output");

  // -------------------------------------------------------------------------
  // grants
  // -------------------------------------------------------------------------

  const grants = ce.command("grants").description("Manage CES grants");

  // grants list
  grants
    .command("list")
    .description("List current CES grants")
    .option("--handle <handle>", "Filter by credential handle")
    .option(
      "--status <status>",
      "Filter by grant status (active, expired, revoked, consumed)",
    )
    .addHelpText(
      "after",
      `
Lists all persistent grants tracked by the Credential Execution Service.
Each grant authorizes a specific credential handle for a constrained purpose.

Grant records never include raw secret values — only metadata (handle,
proposal type, status, timestamps, allowed purposes).

Examples:
  $ assistant credential-execution grants list
  $ assistant credential-execution grants list --handle local_static:github/token
  $ assistant credential-execution grants list --status active --json`,
    )
    .action(
      async (opts: { handle?: string; status?: string }, cmd: Command) => {
        let cleanup: (() => Promise<void>) | undefined;
        try {
          if (!ensureGrantAuditEnabled(cmd)) return;
          const ces = await acquireCesClient();
          cleanup = ces.cleanup;

          const response: ListGrantsResponse = await ces.client.call(
            CesRpcMethod.ListGrants as typeof CesRpcMethod.ListGrants,
            {
              credentialHandle: opts.handle,
              status: opts.status as
                | "active"
                | "expired"
                | "revoked"
                | "consumed"
                | undefined,
            },
          );

          writeOutput(cmd, { ok: true, grants: response.grants });

          if (!shouldOutputJson(cmd)) {
            if (response.grants.length === 0) {
              log.info("No CES grants found");
            } else {
              log.info(`${response.grants.length} CES grant(s):\n`);
              for (const grant of response.grants) {
                printGrantHuman(grant);
                log.info("");
              }
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeOutput(cmd, { ok: false, error: message });
          process.exitCode = 1;
        } finally {
          if (cleanup) await cleanup();
        }
      },
    );

  // grants revoke
  grants
    .command("revoke <grantId>")
    .description("Revoke a CES grant by its stable ID")
    .option("--reason <reason>", "Human-readable reason for revocation")
    .addHelpText(
      "after",
      `
Revokes a specific CES grant, immediately preventing any further use of
that grant for credentialed operations. The grant is permanently removed
from CES state.

Arguments:
  grantId   The stable grant identifier (UUID)

Examples:
  $ assistant credential-execution grants revoke 7a3b1c2d-4e5f-6789-abcd-ef0123456789
  $ assistant credential-execution grants revoke abc123 --reason "credential rotated"`,
    )
    .action(
      async (grantId: string, opts: { reason?: string }, cmd: Command) => {
        let cleanup: (() => Promise<void>) | undefined;
        try {
          if (!ensureGrantAuditEnabled(cmd)) return;
          const ces = await acquireCesClient();
          cleanup = ces.cleanup;

          const response: RevokeGrantResponse = await ces.client.call(
            CesRpcMethod.RevokeGrant as typeof CesRpcMethod.RevokeGrant,
            {
              grantId,
              reason: opts.reason,
            },
          );

          if (response.success) {
            writeOutput(cmd, { ok: true, grantId });

            if (!shouldOutputJson(cmd)) {
              log.info(`Revoked grant ${grantId}`);
            }
          } else {
            writeOutput(cmd, {
              ok: false,
              error: response.error?.message ?? "Failed to revoke grant",
            });
            process.exitCode = 1;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeOutput(cmd, { ok: false, error: message });
          process.exitCode = 1;
        } finally {
          if (cleanup) await cleanup();
        }
      },
    );

  // -------------------------------------------------------------------------
  // audit
  // -------------------------------------------------------------------------

  const audit = ce.command("audit").description("Inspect CES audit records");

  // audit list
  audit
    .command("list")
    .description("List recent CES audit records")
    .option("--handle <handle>", "Filter by credential handle")
    .option("--grant <grantId>", "Filter by grant ID")
    .option("-l, --limit <n>", "Maximum number of records to return", "20")
    .addHelpText(
      "after",
      `
Lists recent audit records from the Credential Execution Service. Each
record is a token-free summary of a credentialed operation (HTTP request
or secure command execution).

Audit records never include raw secrets, raw tokens, raw headers, or raw
response bodies — only sanitized metadata (method, URL template, status
code, credential handle, grant ID, success/failure).

Examples:
  $ assistant credential-execution audit list
  $ assistant credential-execution audit list --limit 50
  $ assistant credential-execution audit list --handle local_static:github/token
  $ assistant credential-execution audit list --grant abc123 --json`,
    )
    .action(
      async (
        opts: { handle?: string; grant?: string; limit: string },
        cmd: Command,
      ) => {
        let cleanup: (() => Promise<void>) | undefined;
        try {
          if (!ensureGrantAuditEnabled(cmd)) return;
          const ces = await acquireCesClient();
          cleanup = ces.cleanup;

          const limit = parseInt(opts.limit, 10) || 20;

          const response: ListAuditRecordsResponse = await ces.client.call(
            CesRpcMethod.ListAuditRecords as typeof CesRpcMethod.ListAuditRecords,
            {
              credentialHandle: opts.handle,
              grantId: opts.grant,
              limit,
            },
          );

          writeOutput(cmd, {
            ok: true,
            records: response.records,
            nextCursor: response.nextCursor,
          });

          if (!shouldOutputJson(cmd)) {
            if (response.records.length === 0) {
              log.info("No CES audit records found");
            } else {
              log.info(`${response.records.length} CES audit record(s):\n`);
              for (const record of response.records) {
                printAuditRecordHuman(record);
                log.info("");
              }
              if (response.nextCursor) {
                log.info("(more records available — use --limit to increase)");
              }
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeOutput(cmd, { ok: false, error: message });
          process.exitCode = 1;
        } finally {
          if (cleanup) await cleanup();
        }
      },
    );
}
