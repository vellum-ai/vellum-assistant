# macOS Keychain Broker Architecture (Legacy)

**Status:** Superseded by CES credential routing
**Last Updated:** 2026-03-22
**Owners:** macOS client + assistant runtime

## Current State

The daemon no longer uses the keychain broker for credential operations. Credential storage is routed through the Credential Execution Service (CES):

1. **CES RPC** (primary) -- stdio RPC to the CES process. Default path for all local modes (desktop app, dev, CLI).
2. **CES HTTP** -- containerized/Docker/managed mode via `CES_CREDENTIAL_URL`.
3. **Encrypted file store** (fallback) -- used when CES is unavailable.

See [`assistant/docs/credential-execution-service.md`](../credential-execution-service.md) for the current credential architecture.

### What remains

The keychain broker is not fully deleted. These components still exist:

| Component | Location | Why it exists |
|---|---|---|
| Keychain broker client | `assistant/src/security/keychain-broker-client.ts` | Used only by workspace migrations 015 and 016 |
| Migration 015 | `assistant/src/workspace/migrations/015-migrate-credentials-to-keychain.ts` | Historical migration that copied encrypted store credentials into keychain |
| Migration 016 | `assistant/src/workspace/migrations/016-migrate-credentials-from-keychain.ts` | Reverse migration that copies keychain credentials back to the encrypted store for CES unification |
| Swift broker server | `clients/macos/vellum-assistant/Security/KeychainBrokerServer.swift` | UDS server in the macOS app; still compiled for release builds (`#if !DEBUG`) |
| Swift broker service | `clients/macos/vellum-assistant/Security/KeychainBrokerService.swift` | `SecItem*` wrapper used by the broker server |
| Gateway credential reader | `gateway/src/credential-reader.ts` | Still tries the keychain broker as a secondary fallback after CES, before the encrypted store |

The broker client and Swift server remain because migrations 015/016 must be able to read/write the keychain for users who previously stored credentials there. These migrations are append-only and cannot be removed. The gateway's broker fallback provides a read path for credentials that may still be in the keychain during the migration window.

### What was removed

- **`KeychainBackend`** class and `createKeychainBackend()` factory -- the daemon's `CredentialBackend` implementation that wrapped the broker client. Removed from `credential-backend.ts`.
- **`resolveBackendAsync()` keychain resolution path** -- the daemon no longer considers `VELLUM_DESKTOP_APP` or `VELLUM_DEV` for backend selection. Backend resolution in `secure-keys.ts` now follows the CES RPC > CES HTTP > encrypted store priority.
- **Dual-writing and broker-unavailable commit behavior** -- the daemon previously committed to the keychain backend even when the broker socket was unreachable, causing operations to fail visibly. This behavior is gone; CES RPC is the primary backend with encrypted store as a graceful fallback.

## Original Design (Historical)

The sections below document the original broker architecture for historical reference. They describe behavior that is no longer active in the daemon's credential resolution path.

### Original problem

Direct keychain access from the daemon process caused repeated macOS authorization prompts, especially during development with ad-hoc signed builds where every rebuild changed the signing identity.

### Original topology

The macOS app embedded a `KeychainBrokerServer` (NWListener on a Unix domain socket) that accepted JSON requests from the daemon and gateway, validated an auth token, and dispatched to `KeychainBrokerService` (a thin `SecItem*` wrapper). The daemon resolved either the keychain backend or encrypted store at startup based on `VELLUM_DESKTOP_APP` and `VELLUM_DEV` environment variables.

### Message contract

Transport: Unix domain socket at `~/.vellum/keychain-broker.sock`, newline-delimited JSON.

| Method | Params | Result |
|---|---|---|
| `broker.ping` | none | `{ pong: true }` |
| `key.get` | `{ account }` | `{ found, value? }` |
| `key.set` | `{ account, value }` | `{ stored: true }` |
| `key.delete` | `{ account }` | `{ deleted: true }` |
| `key.list` | none | `{ accounts: string[] }` |

This protocol is still used by migrations 015/016 via the broker client.

### Security model

- Auth token: 32 random bytes via `SecRandomCopyBytes`, written to `~/.vellum/protected/keychain-broker.token` (0600).
- UDS restricts to local processes; token file restricts to same user.
- Keychain items use `kSecAttrAccessibleAfterFirstUnlock` under the `vellum-assistant` service name.
- Debug builds compile out the entire broker server (`#if !DEBUG`).
