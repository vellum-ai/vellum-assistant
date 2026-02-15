/**
 * Pure validation helpers for credential policies.
 *
 * These functions validate policy input without side effects.
 * They are used during credential creation and update to ensure
 * policy data is well-formed before persistence.
 */

import type { CredentialPolicy, CredentialPolicyInput } from './policy-types.js';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate a credential policy input.
 * Returns a result with `valid: true` if the input is well-formed,
 * or `valid: false` with a list of error messages.
 */
export function validatePolicyInput(input: CredentialPolicyInput): ValidationResult {
  const errors: string[] = [];

  if (input.allowed_tools !== undefined) {
    if (!Array.isArray(input.allowed_tools)) {
      errors.push('allowed_tools must be an array of strings');
    } else {
      for (let i = 0; i < input.allowed_tools.length; i++) {
        const tool = input.allowed_tools[i];
        if (typeof tool !== 'string' || tool.trim().length === 0) {
          errors.push(`allowed_tools[${i}] must be a non-empty string`);
        }
      }
    }
  }

  if (input.allowed_domains !== undefined) {
    if (!Array.isArray(input.allowed_domains)) {
      errors.push('allowed_domains must be an array of strings');
    } else {
      for (let i = 0; i < input.allowed_domains.length; i++) {
        const domain = input.allowed_domains[i];
        if (typeof domain !== 'string' || domain.trim().length === 0) {
          errors.push(`allowed_domains[${i}] must be a non-empty string`);
        }
      }
    }
  }

  if (input.usage_description !== undefined) {
    if (typeof input.usage_description !== 'string') {
      errors.push('usage_description must be a string');
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Convert validated policy input into a CredentialPolicy.
 * Applies strict defaults: empty allowed lists = deny all.
 */
export function toPolicyFromInput(input: CredentialPolicyInput): CredentialPolicy {
  return {
    allowedTools: input.allowed_tools ?? [],
    allowedDomains: input.allowed_domains ?? [],
    usageDescription: input.usage_description,
  };
}

/**
 * Create a strict default policy (deny all usage).
 * Used when a credential is stored without explicit policy.
 */
export function createStrictDefaultPolicy(): CredentialPolicy {
  return {
    allowedTools: [],
    allowedDomains: [],
  };
}
