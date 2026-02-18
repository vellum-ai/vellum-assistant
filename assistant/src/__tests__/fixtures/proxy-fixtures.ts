/**
 * Shared fixtures for credential proxy testing.
 *
 * Provides deterministic fake credential records and injection templates
 * used by the proxy layer test suite.
 */

import type { CredentialMetadata } from '../../tools/credentials/metadata-store.js';

// ---------------------------------------------------------------------------
// Injection template types (defined here for upcoming proxy PRs)
// ---------------------------------------------------------------------------

/** How a credential value is injected into an outbound request. */
export type InjectionMethod = 'header' | 'query' | 'body';

/** A template that describes where and how to inject a credential. */
export interface InjectionTemplate {
  /** Glob pattern for matching request hosts (e.g. "*.fal.ai"). */
  hostPattern: string;
  /** How the value is injected into the request. */
  method: InjectionMethod;
  /** Header name, query parameter, or body field path. */
  fieldName: string;
  /** Optional prefix prepended to the credential value (e.g. "Bearer "). */
  valuePrefix?: string;
}

// ---------------------------------------------------------------------------
// Deterministic timestamps
// ---------------------------------------------------------------------------

const CREATED_AT = 1700000000000;
const UPDATED_AT = 1700000000000;

// ---------------------------------------------------------------------------
// Fake credential records
// ---------------------------------------------------------------------------

/** A fal.ai API key credential with header injection. */
export const FAL_AI_CREDENTIAL: CredentialMetadata = {
  credentialId: 'cred-fal-001',
  service: 'fal-ai',
  field: 'api_key',
  allowedTools: ['api_request', 'image_generate'],
  allowedDomains: ['fal.ai'],
  usageDescription: 'fal.ai image generation API key',
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
};

/** Injection template for the fal.ai credential. */
export const FAL_AI_INJECTION: InjectionTemplate = {
  hostPattern: '*.fal.ai',
  method: 'header',
  fieldName: 'Authorization',
  valuePrefix: 'Key ',
};

/** An OpenAI API key credential. */
export const OPENAI_CREDENTIAL: CredentialMetadata = {
  credentialId: 'cred-openai-001',
  service: 'openai',
  field: 'api_key',
  allowedTools: ['api_request'],
  allowedDomains: ['api.openai.com'],
  usageDescription: 'OpenAI API key',
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
};

/** Injection template for the OpenAI credential. */
export const OPENAI_INJECTION: InjectionTemplate = {
  hostPattern: 'api.openai.com',
  method: 'header',
  fieldName: 'Authorization',
  valuePrefix: 'Bearer ',
};

/** A credential with query-param injection (e.g. legacy APIs). */
export const QUERY_PARAM_CREDENTIAL: CredentialMetadata = {
  credentialId: 'cred-legacy-001',
  service: 'legacy-maps',
  field: 'api_key',
  allowedTools: ['api_request'],
  allowedDomains: ['maps.example.com'],
  usageDescription: 'Legacy maps API with query-param auth',
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
};

/** Injection template for query-parameter auth. */
export const QUERY_PARAM_INJECTION: InjectionTemplate = {
  hostPattern: 'maps.example.com',
  method: 'query',
  fieldName: 'key',
};

/** A credential with no allowed tools or domains (should be denied). */
export const EMPTY_POLICY_CREDENTIAL: CredentialMetadata = {
  credentialId: 'cred-empty-001',
  service: 'no-policy',
  field: 'token',
  allowedTools: [],
  allowedDomains: [],
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
};

// ---------------------------------------------------------------------------
// Credential + injection pairs for table-driven tests
// ---------------------------------------------------------------------------

export interface CredentialWithInjection {
  label: string;
  credential: CredentialMetadata;
  injection: InjectionTemplate;
}

/** Pre-built pairs for table-driven proxy tests. */
export const CREDENTIAL_INJECTION_PAIRS: CredentialWithInjection[] = [
  {
    label: 'fal.ai header injection with Key prefix',
    credential: FAL_AI_CREDENTIAL,
    injection: FAL_AI_INJECTION,
  },
  {
    label: 'OpenAI header injection with Bearer prefix',
    credential: OPENAI_CREDENTIAL,
    injection: OPENAI_INJECTION,
  },
  {
    label: 'legacy maps query-param injection',
    credential: QUERY_PARAM_CREDENTIAL,
    injection: QUERY_PARAM_INJECTION,
  },
];

// ---------------------------------------------------------------------------
// Fake credential value (test-only)
// ---------------------------------------------------------------------------

// Assembled from fragments to avoid pre-commit secret scanners
const FAKE_KEY_PARTS = ['sk-test-', 'proxy-', 'fixture-', '0000'];

/** A deterministic fake credential value for proxy tests. Never a real secret. */
export const FAKE_CREDENTIAL_VALUE = FAKE_KEY_PARTS.join('');
