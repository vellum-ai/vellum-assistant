# Credential Storage — Release Checklist

Pre-release verification checklist for the credential storage security hardening feature.

## Test suites

- [ ] `bun test src/__tests__/credential-vault.test.ts` — store, list, delete, prompt flows
- [ ] `bun test src/__tests__/credential-broker.test.ts` — token authorize/consume/revoke lifecycle
- [ ] `bun test src/__tests__/credential-broker-browser-fill.test.ts` — brokered browser fill with policy enforcement
- [ ] `bun test src/__tests__/credential-metadata-store.test.ts` — JSON metadata CRUD
- [ ] `bun test src/__tests__/credential-policy-validate.test.ts` — policy input validation
- [ ] `bun test src/__tests__/credential-resolve.test.ts` — credential resolution flow
- [ ] `bun test src/__tests__/credential-security-invariants.test.ts` — four security invariants
- [ ] `bun test src/__tests__/credential-security-e2e.test.ts` — end-to-end integration (23 tests)
- [ ] `bun test src/__tests__/secret-onetime-send.test.ts` — one-time send delivery
- [ ] `bun test src/__tests__/secret-ingress-handler.test.ts` — inbound message blocking
- [ ] `bun test src/__tests__/secret-scanner.test.ts` — regex + entropy secret detection

## Security invariant verification

- [ ] **Invariant 1**: Secrets never enter LLM context — store output, confirmation payloads, and lifecycle events all redacted
- [ ] **Invariant 2**: No generic plaintext read API — `getCredentialValue` is module-private, not exported
- [ ] **Invariant 3**: Secrets never logged in plaintext — `redactSensitiveFields` applied to all lifecycle events and hooks
- [ ] **Invariant 4**: Credentials only used for allowed purpose — tool and domain policy enforced by broker

## Manual smoke tests

- [ ] Store a credential via `credential_store` prompt action — verify `SecretPromptView` appears
- [ ] Fill a browser form field — verify the credential value appears in the field, not in tool output
- [ ] Send a message containing a fake AWS key — verify it is blocked with a notice
- [ ] Enable `allowOneTimeSend`, use "Send Once" — verify value is consumed once and not persisted
- [ ] Attempt browser fill with wrong domain — verify denial
- [ ] Attempt browser fill with wrong tool — verify denial
- [ ] Delete a credential — verify metadata and keychain entry are both removed

## Configuration defaults

- [ ] `secretDetection.enabled` defaults to `true`
- [ ] `secretDetection.action` defaults to `"block"`
- [ ] `secretDetection.allowOneTimeSend` defaults to `false`

## Documentation

- [ ] `docs/security/credential-storage.md` matches implementation
- [ ] `ARCHITECTURE.md` credential section accurate (JSON metadata, not SQLite)
- [ ] `README.md` credential storage section accurate
