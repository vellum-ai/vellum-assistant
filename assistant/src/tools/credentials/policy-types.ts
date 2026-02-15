/**
 * Credential usage policy types.
 *
 * These types define the constraints placed on how a stored credential
 * may be used. Policies are attached at credential creation time and
 * enforced by the CredentialBroker before any secret operation.
 */

/** How a credential was originally captured. */
export type CredentialCreationFlow = 'secure_prompt' | 'tool_store' | 'migration';

/** Policy that governs how a credential may be used. */
export interface CredentialPolicy {
  /** Tools allowed to consume this credential (fail-closed if empty). */
  allowedTools: string[];

  /** Registrable domains where this credential may be used (fail-closed if empty). */
  allowedDomains: string[];

  /** Human-readable description of intended usage. */
  usageDescription?: string;

  /** How the credential was originally captured. */
  createdByFlow?: CredentialCreationFlow;
}

/** Input fields for specifying policy when storing a credential. */
export interface CredentialPolicyInput {
  allowed_tools?: string[];
  allowed_domains?: string[];
  usage_description?: string;
}
