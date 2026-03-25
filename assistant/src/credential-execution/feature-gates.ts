/**
 * CES (Credential Execution Service) feature gates.
 *
 * Single source of truth for whether each CES capability is enabled.
 * All checks delegate to the unified feature-flag resolver so that
 * config overrides and registry defaults are respected uniformly.
 *
 * Flag keys use simple kebab-case format (e.g., "ces-tools") and are
 * declared in `meta/feature-flags/feature-flag-registry.json`.
 */

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import type { AssistantConfig } from "../config/schema.js";

// ---------------------------------------------------------------------------
// Canonical flag keys (must match the registry)
// ---------------------------------------------------------------------------

/** Gate for CES tool registration (credential-grant, credential-revoke, credential-list). */
export const CES_TOOLS_FLAG_KEY = "ces-tools" as const;

/** Gate for untrusted-agent shell lockdown when CES credentials are active. */
export const CES_SHELL_LOCKDOWN_FLAG_KEY = "ces-shell-lockdown" as const;

/** Gate for secure tool/command installation via CES. */
export const CES_SECURE_INSTALL_FLAG_KEY = "ces-secure-install" as const;

/** Gate for credential grant and audit inspection surfaces. */
export const CES_GRANT_AUDIT_FLAG_KEY = "ces-grant-audit" as const;

/** Gate for managed sidecar transport in containerized environments. */
export const CES_MANAGED_SIDECAR_FLAG_KEY = "ces-managed-sidecar" as const;

/** Gate for routing credential reads/writes through the CES process. */
export const CES_CREDENTIAL_BACKEND_FLAG_KEY =
  "ces-credential-backend" as const;

// ---------------------------------------------------------------------------
// Public API — predicate functions
// ---------------------------------------------------------------------------

/**
 * Whether CES tools should be registered in the agent loop.
 */
export function isCesToolsEnabled(config: AssistantConfig): boolean {
  return isAssistantFeatureFlagEnabled(CES_TOOLS_FLAG_KEY, config);
}

/**
 * Whether untrusted-agent shell lockdown is active.
 */
export function isCesShellLockdownEnabled(config: AssistantConfig): boolean {
  return isAssistantFeatureFlagEnabled(CES_SHELL_LOCKDOWN_FLAG_KEY, config);
}

/**
 * Whether secure tool/command installation via CES is enabled.
 */
export function isCesSecureInstallEnabled(config: AssistantConfig): boolean {
  return isAssistantFeatureFlagEnabled(CES_SECURE_INSTALL_FLAG_KEY, config);
}

/**
 * Whether credential grant and audit inspection surfaces are available.
 */
export function isCesGrantAuditEnabled(config: AssistantConfig): boolean {
  return isAssistantFeatureFlagEnabled(CES_GRANT_AUDIT_FLAG_KEY, config);
}

/**
 * Whether managed sidecar transport should be used for CES communication.
 */
export function isCesManagedSidecarEnabled(config: AssistantConfig): boolean {
  return isAssistantFeatureFlagEnabled(CES_MANAGED_SIDECAR_FLAG_KEY, config);
}

/**
 * Whether credential reads and writes should be routed through the CES process.
 */
export function isCesCredentialBackendEnabled(
  config: AssistantConfig,
): boolean {
  return isAssistantFeatureFlagEnabled(CES_CREDENTIAL_BACKEND_FLAG_KEY, config);
}
