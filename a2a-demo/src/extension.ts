import type { Part, DataPart } from '@a2a-js/sdk';
import type {
  VellumSocialData,
  VellumSocialRequestData,
  VellumSocialResponseData,
  VellumSocialWorkingData,
} from './types.js';

/**
 * Scans an array of Parts for a DataPart carrying the Vellum social extension.
 * Returns the typed data if found, null otherwise.
 */
export function extractVellumSocial(parts: Part[]): VellumSocialData | null {
  for (const part of parts) {
    if (part.kind === 'data' && (part.data as Record<string, unknown>).extension === 'x-vellum-social-v1') {
      return part.data as unknown as VellumSocialData;
    }
  }
  return null;
}

/**
 * Creates a DataPart carrying a Vellum social request payload.
 */
export function makeRequestPart(data: Omit<VellumSocialRequestData, 'extension'>): DataPart {
  return {
    kind: 'data',
    data: { extension: 'x-vellum-social-v1', ...data },
  };
}

/**
 * Creates a DataPart carrying a Vellum social response payload.
 */
export function makeResponsePart(data: Omit<VellumSocialResponseData, 'extension'>): DataPart {
  return {
    kind: 'data',
    data: { extension: 'x-vellum-social-v1', ...data },
  };
}

/**
 * Creates a DataPart carrying a Vellum social working/HITL payload.
 */
export function makeWorkingPart(data: Omit<VellumSocialWorkingData, 'extension'>): DataPart {
  return {
    kind: 'data',
    data: { extension: 'x-vellum-social-v1', ...data },
  };
}
