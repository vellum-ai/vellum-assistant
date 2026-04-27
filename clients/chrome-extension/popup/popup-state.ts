/**
 * Pure view-state helpers for the popup UI.
 *
 * These functions derive display state from the worker's structured
 * connection health contract and the user-provided gateway URL.
 * They are deliberately side-effect-free so they can be unit tested
 * without a Chrome runtime environment.
 */

import type { AssistantAuthProfile } from '../background/assistant-auth-profile.js';
import type { ExtensionEnvironment } from '../background/extension-environment.js';

// ── Health state types (mirrored from worker.ts) ───────────────────

export type ConnectionHealthState =
  | 'paused'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'auth_required'
  | 'assistant_gone'
  | 'error';

export interface ConnectionHealthDetail {
  lastDisconnectCode?: number;
  lastErrorMessage?: string;
  lastChangeAt: number;
}

// ── Types ──────────────────────────────────────────────────────────

export interface GatewayUrlGetResponse {
  ok: boolean;
  gatewayUrl?: string;
  error?: string;
}

export interface GatewayUrlSetResponse {
  ok: boolean;
  gatewayUrl?: string;
  error?: string;
}

export interface GetStatusResponse {
  connected: boolean;
  authProfile: AssistantAuthProfile | null;
  health: ConnectionHealthState;
  healthDetail: ConnectionHealthDetail;
}

// ── Connection phase & CTA helpers ──────────────────────────────────

export type ConnectionPhase = 'disconnected' | 'connecting' | 'reconnecting' | 'connected' | 'paused';

export interface StatusDisplay {
  dotClass: string;
  text: string;
}

export function deriveSetupMessage(_phase: ConnectionPhase): string | null {
  return null;
}

// ── Health-aware state mapping ──────────────────────────────────────

export function healthToPhase(health: ConnectionHealthState): ConnectionPhase {
  switch (health) {
    case 'connected':
      return 'connected';
    case 'connecting':
      return 'connecting';
    case 'reconnecting':
      return 'reconnecting';
    case 'paused':
      return 'paused';
    case 'auth_required':
      return 'disconnected';
    case 'assistant_gone':
      return 'disconnected';
    case 'error':
      return 'disconnected';
  }
}

export function cleanErrorMessage(raw: string, fallback: string): string {
  return raw
    .replace(/\[trace=[^\]]+\]/g, '')
    .replace(/(?:cloud\s+)?sign-in failed:\s*/gi, '')
    .trim() || fallback;
}

export function deriveHealthStatusDisplay(
  health: ConnectionHealthState,
  detail?: ConnectionHealthDetail,
): StatusDisplay {
  switch (health) {
    case 'connected':
      return { dotClass: 'connected', text: 'Connected' };
    case 'connecting':
      return { dotClass: 'disconnected', text: 'Connecting\u2026' };
    case 'reconnecting':
      return { dotClass: 'paused', text: 'Reconnecting automatically\u2026' };
    case 'paused':
      return { dotClass: 'paused', text: 'Paused' };
    case 'auth_required':
      return {
        dotClass: 'disconnected',
        text: detail?.lastErrorMessage
          ? `Action required: ${cleanErrorMessage(detail.lastErrorMessage, 'check gateway URL and re-pair')}`
          : 'Action required \u2014 check gateway URL and re-pair',
      };
    case 'assistant_gone':
      return { dotClass: 'disconnected', text: 'Assistant no longer available' };
    case 'error': {
      let text = detail?.lastErrorMessage
        ? cleanErrorMessage(detail.lastErrorMessage, 'Connection error')
        : 'Connection error';
      text = text.charAt(0).toUpperCase() + text.slice(1);
      return { dotClass: 'disconnected', text };
    }
  }
}

// ── Troubleshooting visibility ──────────────────────────────────────

export function shouldExpandTroubleshooting(health: ConnectionHealthState): boolean {
  return health === 'auth_required' || health === 'error' || health === 'assistant_gone';
}

export function hasTroubleshootingControls(
  authProfile: AssistantAuthProfile | null,
): boolean {
  return authProfile === 'self-hosted';
}

// ── Environment display helpers ─────────────────────────────────────

export interface EnvironmentStateResponse {
  ok: boolean;
  effectiveEnvironment?: ExtensionEnvironment;
  overrideEnvironment?: ExtensionEnvironment | null;
  buildDefaultEnvironment?: ExtensionEnvironment;
  error?: string;
}

export const ENVIRONMENT_OPTIONS: readonly ExtensionEnvironment[] = [
  'local',
  'dev',
  'staging',
  'production',
] as const;

export function environmentLabel(env: ExtensionEnvironment): string {
  switch (env) {
    case 'local':
      return 'Local';
    case 'dev':
      return 'Development';
    case 'staging':
      return 'Staging';
    case 'production':
      return 'Production';
  }
}

export function deriveEffectiveEnvironment(
  overrideEnvironment: ExtensionEnvironment | null | undefined,
  buildDefaultEnvironment: ExtensionEnvironment | undefined,
): ExtensionEnvironment {
  if (overrideEnvironment) return overrideEnvironment;
  if (buildDefaultEnvironment) return buildDefaultEnvironment;
  return 'dev';
}

export function deriveEnvironmentHint(
  overrideEnvironment: ExtensionEnvironment | null | undefined,
  buildDefaultEnvironment: ExtensionEnvironment | undefined,
): string {
  if (overrideEnvironment) {
    const defaultLabel = buildDefaultEnvironment
      ? environmentLabel(buildDefaultEnvironment)
      : 'dev';
    return `Overriding build default (${defaultLabel})`;
  }
  if (buildDefaultEnvironment) {
    return 'Using build default';
  }
  return 'Using default';
}
