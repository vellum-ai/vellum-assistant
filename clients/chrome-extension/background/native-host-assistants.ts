/**
 * Narrow native-messaging client for the `list_assistants` request.
 *
 * Connects to the native host (`com.vellum.daemon`) via
 * `chrome.runtime.connectNative`, sends a `{ type: "list_assistants" }`
 * frame, and returns the `assistants_response` payload mapped into
 * extension-side assistant descriptor types.
 *
 * The framing/error handling mirrors the pattern in `self-hosted-auth.ts`
 * (`bootstrapLocalToken`) — a single-shot native-messaging port with a
 * timeout guard and explicit port teardown.
 *
 * This client is intentionally separate from the pairing flow: it reads
 * the lockfile inventory without minting any tokens. The worker calls it
 * on demand to populate the assistant catalog that the popup consumes.
 */

import {
  resolveAuthProfile,
  type AssistantAuthProfile,
} from './assistant-auth-profile.js';

const NATIVE_HOST_NAME = 'com.vellum.daemon';
const DEFAULT_LIST_TIMEOUT_MS = 5_000;

/**
 * Extension-side descriptor for a single assistant. Derived from the
 * native host's `assistants_response` payload (which echoes the lockfile
 * `AssistantSummary` shape) plus an auth profile resolved from the
 * lockfile topology.
 */
export interface AssistantDescriptor {
  assistantId: string;
  cloud: string;
  runtimeUrl: string;
  daemonPort: number | undefined;
  isActive: boolean;
  authProfile: AssistantAuthProfile;
}

/** Result shape returned by {@link listAssistants}. */
export interface AssistantCatalog {
  assistants: AssistantDescriptor[];
  activeAssistantId: string | null;
  /**
   * Protocol version reported by the native host. `null` when the native
   * host predates protocol versioning (backward-compatible — treat as
   * "version unknown, assume compatible").
   */
  protocolVersion: number | null;
}

export interface ListAssistantsOptions {
  /**
   * Override the native-messaging timeout. Exposed primarily so tests can
   * run the timeout path without having to wait five real seconds; callers
   * in the extension itself should rely on the default.
   */
  timeoutMs?: number;
}

/**
 * Validate a single assistant entry from the native host response.
 * Returns a fully typed {@link AssistantDescriptor} or `null` when the
 * entry is missing required fields.
 */
function parseAssistantEntry(raw: unknown): AssistantDescriptor | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Record<string, unknown>;
  if (
    typeof entry.assistantId !== 'string' ||
    typeof entry.cloud !== 'string' ||
    typeof entry.runtimeUrl !== 'string'
  ) {
    return null;
  }

  let daemonPort: number | undefined;
  if (
    typeof entry.daemonPort === 'number' &&
    Number.isFinite(entry.daemonPort) &&
    entry.daemonPort > 0 &&
    entry.daemonPort < 65536
  ) {
    daemonPort = entry.daemonPort;
  }

  const authProfile = resolveAuthProfile({
    cloud: entry.cloud,
    runtimeUrl: entry.runtimeUrl,
  });

  return {
    assistantId: entry.assistantId,
    cloud: entry.cloud,
    runtimeUrl: entry.runtimeUrl,
    daemonPort,
    isActive: entry.isActive === true,
    authProfile,
  };
}

/**
 * Spawn the native messaging helper, send a `list_assistants` request,
 * and return the assistant catalog with auth profiles resolved.
 *
 * Error handling follows the same pattern as `bootstrapLocalToken`:
 *   - `{ type: "error", message }` from the helper rejects with that message.
 *   - Port disconnect before a response rejects with `chrome.runtime.lastError`.
 *   - Timeout rejects and force-disconnects the port.
 */
export async function listAssistants(
  options: ListAssistantsOptions = {},
): Promise<AssistantCatalog> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;

  return new Promise<AssistantCatalog>((resolve, reject) => {
    let settled = false;
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);

    const cleanup = (): void => {
      clearTimeout(timer);
      try {
        port.disconnect();
      } catch {
        // Chrome may have already torn the port down.
      }
    };

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      finish(() => reject(new Error('native messaging timeout')));
    }, timeoutMs);

    port.onMessage.addListener((msg: unknown) => {
      if (settled) return;
      if (!msg || typeof msg !== 'object') return;
      const frame = msg as {
        type?: unknown;
        assistants?: unknown;
        activeAssistantId?: unknown;
        protocolVersion?: unknown;
        message?: unknown;
      };

      if (frame.type === 'assistants_response') {
        const rawAssistants = Array.isArray(frame.assistants) ? frame.assistants : [];
        const assistants = rawAssistants
          .map(parseAssistantEntry)
          .filter((a): a is AssistantDescriptor => a !== null);

        const activeAssistantId =
          typeof frame.activeAssistantId === 'string'
            ? frame.activeAssistantId
            : null;

        const protocolVersion =
          typeof frame.protocolVersion === 'number' ? frame.protocolVersion : null;

        finish(() =>
          resolve({
            assistants,
            activeAssistantId,
            protocolVersion,
          }),
        );
        return;
      }

      if (frame.type === 'error') {
        const message =
          typeof frame.message === 'string' ? frame.message : 'native messaging error';
        finish(() => reject(new Error(message)));
        return;
      }

      // Ignore unrecognised frame types — forward-compatible with future
      // protocol extensions.
    });

    port.onDisconnect.addListener(() => {
      if (settled) return;
      const lastError = chrome.runtime.lastError;
      const message =
        lastError?.message ?? 'native messaging disconnected before response';
      finish(() => reject(new Error(message)));
    });

    port.postMessage({ type: 'list_assistants' });
  });
}
