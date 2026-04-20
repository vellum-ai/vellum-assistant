/**
 * Self-hosted capability-token bootstrap for the Vellum chrome extension.
 *
 * Spawns the native messaging helper registered under the host name
 * `com.vellum.daemon`, asks it to exchange the calling extension's origin
 * for a capability token via the assistant's `/v1/browser-extension-pair`
 * endpoint, and persists the returned token in `chrome.storage.local`.
 *
 * This module is the self-hosted counterpart to `cloud-auth.ts`: cloud
 * sign-in uses chrome.identity.launchWebAuthFlow against the Vellum
 * gateway, while self-hosted pairing uses native messaging to talk to a
 * locally running assistant without needing an external OAuth round-trip.
 * Users with a local assistant can pair their extension entirely offline.
 *
 * This module owns the storage + bootstrap state machine for the
 * self-hosted capability token. The relay connection consumes the
 * stored token via `worker.ts::buildRelayModeConfig`, which reads it
 * (along with the assistant runtime port echoed by the native helper)
 * and hands both off to the `RelayConnection` when opening the
 * self-hosted `/v1/browser-relay` WebSocket.
 *
 * Wire format notes: the native helper sends
 * `{ type: "token_response", token, expiresAt }` where `expiresAt` is an
 * ISO 8601 string (per the /v1/browser-extension-pair response shape).
 * We parse it into an epoch-millis number here so the in-memory and
 * on-disk representation matches `StoredCloudToken` and downstream code
 * can rely on a single numeric expiry type across both transports.
 *
 * Storage is assistant-scoped: each assistant ID gets its own storage key
 * (`vellum.localCapabilityToken:<assistantId>`) so switching between
 * assistants never clobbers another assistant's credentials.
 */

export interface StoredLocalToken {
  token: string;
  expiresAt: number; // ms since epoch
  guardianId: string;
  /**
   * Assistant runtime HTTP port echoed by the native messaging helper.
   * When present the chrome extension uses this as the base URL for the
   * self-hosted relay WebSocket instead of the default port (7830).
   * Optional for forward/back-compat with older native helpers that
   * predate PR 3 of the browser-remediation plan.
   */
  assistantPort?: number;
  /**
   * Protocol version reported by the native host. `null` when the native
   * host predates protocol versioning (backward-compatible — treat as
   * "version unknown, assume compatible"). Optional so existing stored
   * tokens without this field remain valid.
   */
  protocolVersion?: number | null;
}

const STORAGE_KEY_PREFIX = 'vellum.localCapabilityToken';
const NATIVE_HOST_NAME = 'com.vellum.daemon';
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 5_000;

/**
 * Window (ms) before `expiresAt` inside which we treat the stored local token
 * as "stale" and proactively re-bootstrap it. 60 seconds mirrors the cloud
 * token stale semantics — gives enough headroom that an in-flight reconnect
 * doesn't race the runtime's own expiry check.
 */
export const LOCAL_TOKEN_STALE_WINDOW_MS = 60_000;

/**
 * Return `true` when the stored local token is expired or within
 * {@link LOCAL_TOKEN_STALE_WINDOW_MS} of expiring. `null`/missing tokens
 * also count as stale so callers can treat them uniformly.
 */
export function isLocalTokenStale(
  token: StoredLocalToken | null,
  now: number = Date.now(),
): boolean {
  if (!token) return true;
  return token.expiresAt - now <= LOCAL_TOKEN_STALE_WINDOW_MS;
}

/**
 * The legacy unscoped storage key used before assistant-scoped keys were
 * introduced. Existing users may have a token stored under this key from
 * a previous version of the extension. The migration helpers below
 * transparently promote it to the new scoped key on first read.
 *
 * Exported so the worker can fall back to reading/writing this key when
 * no assistant is selected yet (backward-compatible connect/pair flow).
 */
export const LEGACY_LOCAL_STORAGE_KEY = 'vellum.localCapabilityToken';

/**
 * Build the assistant-scoped chrome.storage.local key for a local
 * capability token. Uses a colon separator so the key is
 * `vellum.localCapabilityToken:<assistantId>`.
 */
export function localTokenStorageKey(assistantId: string): string {
  return `${STORAGE_KEY_PREFIX}:${assistantId}`;
}

export interface BootstrapLocalTokenOptions {
  /**
   * Override the native-messaging timeout. Exposed primarily so tests can
   * run the timeout path without having to wait five real seconds; callers
   * in the extension itself should rely on the default.
   */
  timeoutMs?: number;
  /**
   * Optional environment override. When provided, the native host uses
   * this environment to resolve lockfile paths and daemon ports instead of
   * the process-level `VELLUM_ENVIRONMENT`. This lets the extension switch
   * environments (e.g. `dev`, `staging`, `production`) without restarting
   * Chrome.
   */
  environment?: string;
}

/**
 * Validate and return a parsed {@link StoredLocalToken} from a raw storage
 * value, or `null` when the value is missing, malformed, or expired.
 */
export function validateLocalToken(raw: unknown): StoredLocalToken | null {
  if (!raw || typeof raw !== 'object') return null;
  const token = raw as StoredLocalToken;
  if (
    typeof token.token !== 'string' ||
    typeof token.expiresAt !== 'number' ||
    typeof token.guardianId !== 'string'
  ) {
    return null;
  }
  if (token.expiresAt <= Date.now()) return null;
  // Strip an invalid `assistantPort` (e.g. left over from a future
  // schema we don't know how to parse) rather than rejecting the whole
  // token — the token itself is still usable, we just fall back to the
  // default relay port.
  if (
    token.assistantPort !== undefined &&
    (typeof token.assistantPort !== 'number' ||
      !Number.isFinite(token.assistantPort) ||
      token.assistantPort <= 0 ||
      token.assistantPort > 65535)
  ) {
    const { assistantPort: _ignored, ...rest } = token;
    return rest;
  }
  return token;
}

/**
 * Check for a token stored under the legacy unscoped key
 * (`vellum.localCapabilityToken`). If found and valid, migrate it to the
 * new assistant-scoped key and remove the legacy key. The migration is
 * idempotent — once the legacy key is removed, subsequent calls are a
 * no-op.
 *
 * Returns the migrated token or `null`.
 */
async function migrateLegacyLocalToken(assistantId: string): Promise<StoredLocalToken | null> {
  const scopedKey = localTokenStorageKey(assistantId);

  // Only migrate when the scoped key is still empty — avoids clobbering
  // a token that was stored directly under the scoped key after pairing.
  const scopedResult = await chrome.storage.local.get(scopedKey);
  if (scopedResult[scopedKey] !== undefined) return null;

  const legacyResult = await chrome.storage.local.get(LEGACY_LOCAL_STORAGE_KEY);
  const legacyToken = validateLocalToken(legacyResult[LEGACY_LOCAL_STORAGE_KEY]);
  if (!legacyToken) return null;

  // Write to the new scoped key and remove the legacy key atomically
  // (as atomic as chrome.storage.local allows — both ops are awaited).
  await chrome.storage.local.set({ [scopedKey]: legacyToken });
  await chrome.storage.local.remove(LEGACY_LOCAL_STORAGE_KEY);

  return legacyToken;
}

/**
 * Read the stored local capability token for a specific assistant.
 * Returns `null` when nothing is stored, the value is malformed, or it
 * has expired.
 *
 * On the first call after the extension upgrades to assistant-scoped
 * storage keys, this function transparently migrates any token stored
 * under the legacy unscoped key to the new scoped key.
 */
export async function getStoredLocalToken(assistantId: string): Promise<StoredLocalToken | null> {
  const key = localTokenStorageKey(assistantId);
  const result = await chrome.storage.local.get(key);
  const token = validateLocalToken(result[key]);
  if (token) return token;

  // Fallback: migrate a legacy unscoped token if no scoped token exists.
  return migrateLegacyLocalToken(assistantId);
}

/**
 * Remove the stored local capability token for a specific assistant.
 */
export async function clearLocalToken(assistantId: string): Promise<void> {
  await chrome.storage.local.remove(localTokenStorageKey(assistantId));
}

async function persistLocalToken(assistantId: string | null, token: StoredLocalToken): Promise<void> {
  const key = assistantId ? localTokenStorageKey(assistantId) : LEGACY_LOCAL_STORAGE_KEY;
  await chrome.storage.local.set({ [key]: token });
}

/**
 * Parse the helper's `expiresAt` field into an epoch-millis number.
 *
 * The native helper echoes whatever the assistant's /v1/browser-extension-pair
 * endpoint returned, which is an ISO 8601 string per PR 11. We tolerate a
 * numeric value as well (belt and braces) so a future helper change that
 * forwards a raw number doesn't break the extension.
 */
function parseExpiresAt(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  if (typeof raw === 'string' && raw.length > 0) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

/**
 * Spawns the native messaging helper via `chrome.runtime.connectNative`,
 * posts a `request_token` frame, awaits the helper's `token_response`,
 * and persists the returned capability token.
 *
 * Error handling:
 * - If the helper emits `{ type: "error", message }`, rejects with that
 *   message. The helper uses this shape for allowlist violations,
 *   unreachable assistant, and malformed responses from the pair endpoint.
 * - If the port disconnects before a response arrives, rejects with the
 *   `chrome.runtime.lastError` message (Chrome surfaces native-messaging
 *   spawn failures through this channel — e.g. the host manifest isn't
 *   installed, or the binary exited non-zero before writing a frame).
 * - If no frame arrives within `DEFAULT_BOOTSTRAP_TIMEOUT_MS`, rejects
 *   with a timeout error and force-disconnects the port so the helper
 *   process doesn't leak.
 */
export async function bootstrapLocalToken(
  assistantId: string | null,
  options: BootstrapLocalTokenOptions = {},
): Promise<StoredLocalToken> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS;
  return new Promise<StoredLocalToken>((resolve, reject) => {
    // `settled` is flipped synchronously the moment we observe a decisive
    // frame (token_response / error / timeout / disconnect) so that a
    // racing onDisconnect — Chrome sometimes closes the native port the
    // instant the helper exits, even if we've already received a valid
    // token frame — can't win the race and reject a successful pairing.
    //
    // Critically, for the token_response happy path we mark `settled`
    // BEFORE awaiting `persistLocalToken`. If we waited until the storage
    // write resolved, an onDisconnect firing during that microtask would
    // still see `settled === false` and reject the promise despite having
    // a valid in-memory token.
    let settled = false;
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);

    const cleanup = (): void => {
      clearTimeout(timer);
      try {
        port.disconnect();
      } catch {
        // Chrome may have already torn the port down — ignore.
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
        token?: unknown;
        expiresAt?: unknown;
        guardianId?: unknown;
        assistantPort?: unknown;
        protocolVersion?: unknown;
        message?: unknown;
      };

      if (frame.type === 'token_response') {
        const expiresAt = parseExpiresAt(frame.expiresAt);
        if (
          typeof frame.token !== 'string' ||
          expiresAt === null ||
          typeof frame.guardianId !== 'string'
        ) {
          finish(() =>
            reject(new Error('native messaging returned malformed token_response')),
          );
          return;
        }
        // Forward/back-compat: accept missing or malformed
        // assistantPort. Older native helpers (pre-PR 3 of the
        // browser-remediation plan) don't emit this field, in which
        // case the worker falls back to the configured/default
        // relay port.
        let assistantPort: number | undefined;
        const rawPort = frame.assistantPort;
        if (
          typeof rawPort === 'number' &&
          Number.isFinite(rawPort) &&
          rawPort > 0 &&
          rawPort <= 65535
        ) {
          assistantPort = rawPort;
        }
        // Forward/back-compat: accept missing protocolVersion. Older
        // native helpers that predate protocol versioning don't emit
        // this field; treat as null (version unknown, assume compatible).
        const protocolVersion =
          typeof frame.protocolVersion === 'number' ? frame.protocolVersion : null;

        const stored: StoredLocalToken = {
          token: frame.token,
          expiresAt,
          guardianId: frame.guardianId,
          ...(assistantPort !== undefined ? { assistantPort } : {}),
          protocolVersion,
        };

        // Mark settled + tear down the port SYNCHRONOUSLY so a racing
        // onDisconnect listener can't reject the promise after we've
        // already received a valid token. The persistence write below
        // is awaited afterwards, but it no longer gates `settled`.
        settled = true;
        cleanup();

        // Persist asynchronously. If the storage write fails, we log
        // the error and resolve with the in-memory token anyway — the
        // caller can still use it for the current session even if we
        // couldn't durably save it. This also matches the comment
        // above: a storage failure shouldn't block the caller from
        // getting a token they just successfully negotiated.
        persistLocalToken(assistantId, stored).then(
          () => resolve(stored),
          (err: unknown) => {
            const detail = err instanceof Error ? err.message : String(err);
            console.warn(
              `[vellum-relay] failed to persist local capability token: ${detail}`,
            );
            resolve(stored);
          },
        );
        return;
      }

      if (frame.type === 'error') {
        const message = typeof frame.message === 'string' ? frame.message : 'native messaging error';
        finish(() => reject(new Error(message)));
        return;
      }

      // Ignore any unrecognised frame types — the helper currently only
      // emits `token_response` and `error`, but tolerating unknowns means
      // a future protocol extension won't accidentally trip this path.
    });

    port.onDisconnect.addListener(() => {
      if (settled) return;
      const lastError = chrome.runtime.lastError;
      const message = lastError?.message ?? 'native messaging disconnected before response';
      // `finish` will call port.disconnect() again, but that's a no-op
      // after Chrome has already torn the port down on its side.
      finish(() => reject(new Error(message)));
    });

    // Include the assistantId in the pair request so the native host
    // can scope the pairing to a specific assistant's runtime. When
    // assistantId is null (legacy flow), the field is omitted and the
    // native host falls back to the default assistant.
    const pairMessage: Record<string, unknown> = { type: 'request_token' };
    if (assistantId) {
      pairMessage.assistantId = assistantId;
    }
    if (options.environment) {
      pairMessage.environment = options.environment;
    }
    port.postMessage(pairMessage);
  });
}
