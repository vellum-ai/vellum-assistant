# Credential Storage — Security Model

## Overview

The credential storage system lets the assistant securely store and use credentials (API keys, tokens, passwords) without exposing secret values to the LLM, logs, or tool outputs. The system is designed around four invariants.

## Security Invariants

### 1. Secrets never enter LLM context

Secret values are never included in:
- Model messages (user, assistant, or system role)
- Tool output returned to the model
- Lifecycle events emitted by the tool executor
- Confirmation request payloads sent to the client

The `credential_store` tool returns metadata-only confirmations like "Credential stored securely" — never the value itself.

### 2. No generic plaintext read API

There is no tool-layer function that returns a stored secret as plaintext. The only consumer of raw secret values is the `CredentialBroker`, which injects values directly into tool execution (e.g., filling a browser form field) without passing them through the model.

### 3. Secrets never logged in plaintext

All logging in the credential flow uses metadata-only fields: `service`, `field`, `requestId`, `delivery`. The `SecretPrompter` and `SecretPromptManager` never log the `value` parameter. Lifecycle events are recursively redacted for keys like `value`, `password`, `token`, and `secret`.

### 4. Credentials only used for allowed purpose

Each credential can specify:
- **`allowedTools`**: Which tools may consume this credential (e.g., `["headless-browser"]`).
- **`allowedDomains`**: Which domains the credential may be sent to (e.g., `["github.com"]`). Uses registrable-domain matching (subdomains are permitted).

The `CredentialBroker` enforces these policies at use time. Requests outside the allowed scope are denied.

## Architecture

### Storage split

| Component | Location | Contents |
|-----------|----------|----------|
| Secret values | macOS Keychain (primary) or encrypted file fallback | Encrypted values keyed as `credential:{service}:{field}`. On Linux/headless or when Keychain is unavailable, `secure-keys.ts` falls back to an encrypted file backend. |
| Credential metadata | JSON file (`~/.vellum/data/credentials/metadata.json`) | Service, field, label, usage policy, timestamps |
| Config | `~/.vellum/config.*` | `secretDetection` settings |

This split means the daemon process can enumerate credentials and check policies without ever loading plaintext secrets into memory. Secrets are fetched from the Keychain only at the point of use, by the broker.

### Secure prompt flow

1. The LLM calls `credential_store` with `action: "prompt"`.
2. The vault tool delegates to `SecretPrompter`, which sends a `secret_request` IPC message.
3. The macOS client shows a floating `SecretPromptView` panel with a `SecureField`.
4. The user enters the value and clicks "Save" (or "Send Once" if enabled).
5. The client sends `secret_response` back via IPC.
6. For "store" delivery, the vault tool stores the value in the Keychain. For "transient_send" delivery, the vault tool hands the value to the `CredentialBroker`, which holds it in memory for the next `consume` or `browserFill` call and then discards it. Note: the value is never returned to the vault tool's output or passed back to the model.
7. The tool returns a metadata-only confirmation to the model.

### Secret ingress blocking

When `secretDetection.enabled` is `true` and `secretDetection.action` is `"block"` (the default), inbound user messages and task submissions are scanned for secret patterns before entering the model context:

- **Regex patterns**: AWS access keys (`AKIA...`), GitHub tokens (`ghp_...`, `gho_...`), generic API key formats, private keys, and more.
- **Entropy detection**: High-entropy strings that resemble random tokens.
- **Placeholder allowlist**: Common example/placeholder values (like `AKIA...EXAMPLE`) are excluded from detection.

If secrets are detected, the message is blocked and the user receives a notice suggesting they use the secure credential prompt instead.

### Brokered credential use

Tools that need credential values (e.g., `headless-browser` for form filling) go through the `CredentialBroker`:

1. The tool calls `broker.use(service, field, tool, domain)`.
2. The broker checks the credential's `allowedTools` and `allowedDomains` policy.
3. If allowed, the broker fetches the value from the Keychain and injects it directly into the tool's execution context.
4. The value is never returned to the model or logged.

## Configuration

All credential security settings live under `secretDetection` in the assistant config:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable secret detection scanning |
| `action` | `"redact" \| "warn" \| "block"` | `"block"` | What to do when secrets are detected in user input |
| `entropyThreshold` | `number` | `4.0` | Shannon entropy threshold for random-string detection |
| `allowOneTimeSend` | `boolean` | `false` | Enable "Send Once" delivery (value used immediately, not persisted) |

### Operator guidance

- **Default posture is strict**: `action: "block"` and `allowOneTimeSend: false` ensure secrets always go through the Keychain.
- **Relaxing `action` to `"warn"` or `"redact"`**: These modes **completely disable** inbound secret scanning. The ingress check returns immediately without scanning, logging, or redacting — secrets in user messages pass through to the model with no detection at all. These modes only affect tool-output handling, not user input. Only `"block"` scans inbound messages and prevents secrets from reaching the model context. Useful during migration but significantly reduces security.
- **Enabling `allowOneTimeSend`**: Adds a "Send Once" button to the secret prompt. The value is used for one operation and then discarded. Useful for temporary tokens. The value is still never shown to the model.

## Rollback

- If ingress blocking is too aggressive, set `secretDetection.action` to `"warn"` or `"redact"` while tuning false positives. Note that this completely disables inbound secret scanning — secrets in user messages will pass through to the model undetected.
- If one-time send behaves incorrectly, set `allowOneTimeSend` to `false` to revert to store-only mode.
- The `CredentialBroker` can be bypassed by reverting its integration PR — the vault tool continues to work for storage without brokered use.

## Key files

| File | Role |
|------|------|
| `assistant/src/tools/credentials/vault.ts` | `credential_store` tool implementation |
| `assistant/src/security/secure-keys.ts` | Keychain read/write wrapper |
| `assistant/src/tools/credentials/metadata-store.ts` | JSON file metadata CRUD |
| `assistant/src/tools/credentials/broker.ts` | Brokered credential access with policy enforcement |
| `assistant/src/tools/credentials/tool-policy.ts` | Tool allowlist matching |
| `assistant/src/tools/credentials/domain-policy.ts` | Registrable-domain matching |
| `assistant/src/security/redaction.ts` | Recursive field-level redaction for sensitive keys |
| `assistant/src/tools/credentials/policy-validate.ts` | Policy input validation |
| `assistant/src/tools/credentials/policy-types.ts` | Policy type definitions |
| `assistant/src/permissions/secret-prompter.ts` | IPC secret request/response flow |
| `assistant/src/security/secret-scanner.ts` | Regex + entropy secret detection |
| `assistant/src/security/secret-ingress.ts` | Inbound message blocking |
| `clients/macos/.../SecretPromptManager.swift` | macOS secure prompt UI |
| `assistant/src/__tests__/credential-security-invariants.test.ts` | Security invariant test harness |
