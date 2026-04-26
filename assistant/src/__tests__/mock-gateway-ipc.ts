/**
 * Global test utility for mocking gateway IPC calls via
 * `@vellumai/gateway-client/ipc-client`.
 *
 * Usage:
 *   import { mockGatewayIpc, resetMockGatewayIpc } from "../__tests__/mock-gateway-ipc.js";
 *
 *   beforeEach(() => resetMockGatewayIpc());
 *   afterEach(() => resetMockGatewayIpc());
 *
 *   it("uses IPC flags", async () => {
 *     mockGatewayIpc({ "my-flag": true });
 *     await initFeatureFlagOverrides();
 *     ...
 *   });
 *
 *   it("simulates socket error", async () => {
 *     mockGatewayIpc(null, { error: true, code: "ENOENT" });
 *     ...
 *   });
 *
 * The mock is registered in the test preload (test-preload.ts) so every test
 * file gets a no-op IPC layer by default — no test accidentally connects to
 * a real gateway socket. Call `mockGatewayIpc()` to configure specific
 * responses when the test cares about the IPC result.
 *
 * Mocks `@vellumai/gateway-client/ipc-client` at the package level so the
 * assistant's thin wrapper in `ipc/gateway-client.ts` (which delegates to
 * the package) gets the fake implementation. Non-gateway IPC paths (e.g.
 * CLI IPC) are unaffected since they don't import from the package.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mock } from "bun:test";

// ---------------------------------------------------------------------------
// Configurable state
// ---------------------------------------------------------------------------

/** IPC result the fake gateway will return (keyed by method name). */
let ipcResults: Record<string, unknown> = {};

/** Whether the fake ipcCall should simulate a connection error. */
let simulateError = false;

// ---------------------------------------------------------------------------
// Built-in mock handlers
// ---------------------------------------------------------------------------

/**
 * Handles `create_guardian_binding` by writing directly to the test's
 * assistant DB — mirrors what the real gateway does (write to assistant
 * DB + gateway DB). Tests only have the assistant DB, so we skip the
 * gateway DB portion.
 */
function handleCreateGuardianBinding(
  params: Record<string, unknown>,
): Record<string, unknown> {
  // Late import to avoid circular deps at mock-registration time.
  // getSqlite() returns the raw bun:sqlite Database instance that tests
  // initialise via initializeDb() in their beforeEach.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getSqlite } = require("../memory/db.js");
  const db = getSqlite();

  const channel = params.channel as string;
  const externalUserId = params.externalUserId as string;
  const deliveryChatId = params.deliveryChatId as string;
  const guardianPrincipalId = params.guardianPrincipalId as string;
  const displayName = (params.displayName as string) ?? externalUserId;
  const verifiedVia = (params.verifiedVia as string) ?? "challenge";
  const now = Date.now();

  // Check if a guardian contact already exists for this principal
  const existingContact = db
    .query(
      `SELECT id FROM contacts WHERE role = 'guardian' AND principal_id = ? LIMIT 1`,
    )
    .get(guardianPrincipalId) as { id: string } | null;

  // Also check for an existing channel by (type, address) — the unique
  // constraint is on these columns, and re-verification for the same
  // channel may come through with a different principal.
  const existingChannelByAddress = db
    .query(
      `SELECT cc.id, cc.contact_id FROM contact_channels cc
       WHERE cc.type = ? AND cc.address = ? LIMIT 1`,
    )
    .get(channel, externalUserId) as { id: string; contact_id: string } | null;

  // If the channel already exists, use its contact (may differ from principalId lookup)
  const contactId =
    existingContact?.id ?? existingChannelByAddress?.contact_id ?? randomUUID();

  // Determine if the contact row exists in the DB (either by principal or by channel ownership)
  const contactExists = !!(existingContact || existingChannelByAddress);

  const existingChannel = existingChannelByAddress ?? null;
  const channelId = existingChannel?.id ?? randomUUID();

  db.exec("BEGIN IMMEDIATE");
  try {
    if (contactExists) {
      db.run(
        `UPDATE contacts SET display_name = ?, role = 'guardian', principal_id = ?, updated_at = ? WHERE id = ?`,
        [displayName, guardianPrincipalId, now, contactId],
      );
    } else {
      db.run(
        `INSERT INTO contacts (id, display_name, role, principal_id, notes, created_at, updated_at)
         VALUES (?, ?, 'guardian', ?, 'guardian', ?, ?)`,
        [contactId, displayName, guardianPrincipalId, now, now],
      );
    }

    if (existingChannel) {
      db.run(
        `UPDATE contact_channels
         SET address = ?, external_user_id = ?, external_chat_id = ?,
             status = 'active', policy = 'allow', verified_at = ?,
             verified_via = ?, updated_at = ?
         WHERE id = ?`,
        [externalUserId, externalUserId, deliveryChatId, now, verifiedVia, now, channelId],
      );
    } else {
      db.run(
        `INSERT INTO contact_channels
           (id, contact_id, type, address, external_user_id, external_chat_id,
            is_primary, status, policy, verified_at, verified_via, interaction_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, 'active', 'allow', ?, ?, 0, ?)`,
        [channelId, contactId, channel, externalUserId, externalUserId, deliveryChatId, now, verifiedVia, now],
      );
    }

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return { contactId, channelId, guardianPrincipalId, channel };
}

/**
 * Dispatch an IPC call — checks built-in handlers first, then
 * configured mock results, then returns undefined.
 */
function dispatchIpcCall(
  method: string,
  params?: Record<string, unknown>,
): unknown {
  if (simulateError) return undefined;

  // Built-in handlers for gateway-owned write operations
  if (method === "create_guardian_binding" && params) {
    return handleCreateGuardianBinding(params);
  }

  return method in ipcResults ? ipcResults[method] : undefined;
}

// ---------------------------------------------------------------------------
// FakePersistentIpcClient — mirrors PersistentIpcClient API
// ---------------------------------------------------------------------------

class FakePersistentIpcClient extends EventEmitter {
  async call(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    if (simulateError) {
      throw new Error("Mock IPC socket error");
    }
    return dispatchIpcCall(method, params);
  }

  destroy(): void {
    /* no-op */
  }
}

// ---------------------------------------------------------------------------
// Register the mock (called once from test-preload.ts)
// ---------------------------------------------------------------------------

export function installGatewayIpcMock(): void {
  mock.module("@vellumai/gateway-client/ipc-client", () => ({
    ipcCall: async (
      _socketPath: string,
      method: string,
      params?: Record<string, unknown>,
    ): Promise<unknown> => {
      return dispatchIpcCall(method, params);
    },
    PersistentIpcClient: FakePersistentIpcClient,
  }));
}

// ---------------------------------------------------------------------------
// Public API for tests
// ---------------------------------------------------------------------------

/**
 * Configure the fake gateway IPC response.
 *
 * @param flags — feature flag map returned by `get_feature_flags`. Pass
 *   `null` to skip setting a result (useful when only simulating errors).
 * @param opts.error — simulate a socket connection error
 * @param opts.code — error code (kept for API compat, unused by package mock)
 * @param opts.results — raw method->result map for arbitrary IPC methods
 */
export function mockGatewayIpc(
  flags?: Record<string, boolean> | null,
  opts?: { error?: boolean; code?: string; results?: Record<string, unknown> },
): void {
  if (flags != null) {
    ipcResults["get_feature_flags"] = flags;
  }
  if (opts?.results) {
    Object.assign(ipcResults, opts.results);
  }
  if (opts?.error) {
    simulateError = true;
  }
}

/**
 * Reset all IPC mock state back to defaults (empty flags, no errors).
 */
export function resetMockGatewayIpc(): void {
  ipcResults = {};
  simulateError = false;
}
