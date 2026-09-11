import { loadRawConfig, saveRawConfig } from "../config/loader.js";
import type { McpConfig } from "../config/schemas/mcp.js";
import { reloadMcpServers } from "../daemon/mcp-reload-service.js";
import { Mutex } from "../util/mutex.js";
import { withMcpConfigWrite } from "./config-write-lock.js";
import { withMcpCredentialLock } from "./credential-coordination.js";
import {
  cancelCurrentMcpAuth,
  getMcpAuthState,
  setMcpAuthCancellationCleanupPending,
} from "./mcp-auth-state.js";
import { deleteMcpHeaders } from "./mcp-header-store.js";
import { publishMcpChanged } from "./sync.js";

export { withMcpConfigWrite } from "./config-write-lock.js";

const servers = new Map<string, { mutex: Mutex; users: number }>();

export async function withMcpServerOperation<T>(
  serverId: string,
  operation: () => Promise<T>,
): Promise<T> {
  let state = servers.get(serverId);
  if (!state) {
    state = { mutex: new Mutex(), users: 0 };
    servers.set(serverId, state);
  }
  state.users++;
  try {
    return await state.mutex.withLock(operation);
  } finally {
    state.users--;
    if (state.users === 0) {
      servers.delete(serverId);
    }
  }
}

/** Called inside the server operation lock before a new authorization attempt. */
export function beginMcpConnection(serverId: string): Promise<void> {
  return withMcpCredentialLock(serverId, async (lease) => {
    lease.advance();
  });
}

export class McpTeardownError extends Error {
  constructor(
    message: string,
    readonly removalSaved: boolean,
  ) {
    super(message);
  }
}

export async function cancelMcpConnectionAttempt(
  serverId: string,
  attemptId: string,
): Promise<boolean> {
  const { deleteMcpOAuthCredentials } = await import("./mcp-oauth-provider.js");
  return withMcpCredentialLock(serverId, async (lease) => {
    const state = getMcpAuthState(serverId);
    if (
      state?.attemptId !== attemptId ||
      !(
        state.status === "pending" ||
        (state.status === "error" && state.cancellationCleanupPending)
      )
    ) {
      return false;
    }
    cancelCurrentMcpAuth(serverId);
    setMcpAuthCancellationCleanupPending(serverId, attemptId, true);
    lease.advance();
    try {
      const result = await deleteMcpOAuthCredentials(serverId);
      if (!result.ok) {
        throw new Error(
          "Authorization cancelled, but credential cleanup failed; retry cancelling",
        );
      }
      setMcpAuthCancellationCleanupPending(serverId, attemptId, false);
      return true;
    } finally {
      lease.advance();
      await publishMcpChanged();
    }
  });
}

/** The caller validates workspace ownership while holding the server lock. */
export async function teardownMcpConnection(
  serverId: string,
  options: { removeConfig: boolean },
): Promise<void> {
  const { deleteMcpOAuthCredentials } = await import("./mcp-oauth-provider.js");
  cancelCurrentMcpAuth(serverId);
  let removalSaved = false;
  try {
    await withMcpConfigWrite(() =>
      withMcpCredentialLock(serverId, async (lease) => {
        lease.advance();
        try {
          const oauth = await deleteMcpOAuthCredentials(serverId);
          const headers = options.removeConfig
            ? await deleteMcpHeaders(serverId)
            : true;
          if (!oauth.ok || !headers) {
            const failed = [
              ...oauth.failedKeys,
              ...(!headers ? ["headers"] : []),
            ];
            throw new McpTeardownError(
              `Credential cleanup failed (${failed.join(
                ", ",
              )}); retry disconnecting`,
              false,
            );
          }
          const authState = getMcpAuthState(serverId);
          if (
            authState?.status === "error" &&
            authState.cancellationCleanupPending
          ) {
            setMcpAuthCancellationCleanupPending(
              serverId,
              authState.attemptId,
              false,
            );
          }
          if (options.removeConfig) {
            const raw = loadRawConfig();
            const servers = (raw.mcp as Partial<McpConfig> | undefined)
              ?.servers;
            if (servers) {
              delete servers[serverId];
              saveRawConfig(raw);
              removalSaved = true;
            }
          }
        } finally {
          // A provider constructed during cleanup must not inherit its generation.
          lease.advance();
        }
      }),
    );
  } catch (err) {
    if (removalSaved) {
      throw new McpTeardownError(
        "Removal was saved, but runtime cleanup failed; retry removing the integration",
        true,
      );
    }
    throw err;
  } finally {
    await publishMcpChanged();
  }
  try {
    const result = await reloadMcpServers({ requireCleanup: true });
    if (!result.success) {
      throw new Error(result.error);
    }
  } catch {
    throw new McpTeardownError(
      options.removeConfig
        ? "Removal was saved, but runtime cleanup failed; retry removing the integration"
        : "Credentials were cleared, but runtime cleanup failed; retry disconnecting",
      options.removeConfig,
    );
  }
}
