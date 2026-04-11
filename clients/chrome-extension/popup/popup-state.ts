/**
 * Pure view-state helpers for the popup UI.
 *
 * These functions derive display state from the assistant catalog,
 * selection data, and connection phase. They are deliberately
 * side-effect-free so they can be unit tested without a Chrome runtime
 * environment.
 *
 * The popup exposes two primary actions:
 *   - **Connect** — the only first-step CTA. The worker handles auth
 *     bootstrap (pairing/sign-in) automatically when `interactive=true`.
 *   - **Pause** — user-facing stop action that halts the relay but
 *     preserves credentials so reconnect is instant.
 */

import type { AssistantDescriptor } from '../background/native-host-assistants.js';
import type { AssistantAuthProfile } from '../background/assistant-auth-profile.js';

// ── Types ──────────────────────────────────────────────────────────

/**
 * Response shape from the worker's `assistants-get` message. Mirrors
 * the return type of `getAssistantCatalogAndSelection()` in worker.ts
 * with an `ok` envelope.
 */
export interface AssistantsGetResponse {
  ok: boolean;
  assistants?: AssistantDescriptor[];
  selected?: AssistantDescriptor | null;
  authProfile?: AssistantAuthProfile | null;
  error?: string;
}

/**
 * Response shape from the worker's `assistant-select` message.
 */
export interface AssistantSelectResponse {
  ok: boolean;
  selected?: AssistantDescriptor | null;
  authProfile?: AssistantAuthProfile | null;
  error?: string;
}

/**
 * Describes how the popup should render the assistant selector area.
 *
 * - `hidden`:  No selector shown. Applies when a single assistant
 *              exists (auto-selected) or when the catalog is empty.
 * - `visible`: The dropdown should be rendered with the given option
 *              list and pre-selected value.
 */
export type SelectorDisplay =
  | { kind: 'hidden' }
  | { kind: 'visible'; options: AssistantOption[]; selectedId: string };

export interface AssistantOption {
  assistantId: string;
  label: string;
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Build a human-readable label for an assistant descriptor.
 *
 * Uses the `assistantId` as the display label. This keeps the dropdown
 * consistent with the lockfile's assistant identifiers.
 */
export function assistantLabel(descriptor: AssistantDescriptor): string {
  return descriptor.assistantId;
}

/**
 * Derive the selector display state from the assistant catalog.
 *
 * Rules:
 *   - 0 or 1 assistant: hidden (auto-select handled by worker).
 *   - 2+ assistants: visible dropdown with options in lockfile order
 *     and the resolved `selected` pre-selected.
 */
export function deriveSelectorDisplay(
  assistants: AssistantDescriptor[],
  selected: AssistantDescriptor | null,
): SelectorDisplay {
  if (assistants.length <= 1) {
    return { kind: 'hidden' };
  }

  const options: AssistantOption[] = assistants.map((a) => ({
    assistantId: a.assistantId,
    label: assistantLabel(a),
  }));

  const selectedId = selected?.assistantId ?? assistants[0]!.assistantId;

  return { kind: 'visible', options, selectedId };
}

/**
 * Determine which auth status text and style to show for the Local
 * section based on the current auth profile.
 *
 * Returns `null` when the local section is irrelevant (cloud-only
 * assistant).
 */
export function shouldShowLocalSection(
  authProfile: AssistantAuthProfile | null,
): boolean {
  return authProfile === 'local-pair';
}

/**
 * Determine whether the Cloud section should be shown based on the
 * current auth profile.
 */
export function shouldShowCloudSection(
  authProfile: AssistantAuthProfile | null,
): boolean {
  return authProfile === 'cloud-oauth';
}

// ── Connection phase & CTA helpers ──────────────────────────────────

/**
 * The popup's connection lifecycle phase. Drives the primary/secondary
 * button labels, enablement, and status indicator.
 *
 * - `disconnected`    — idle, no active relay connection.
 * - `connecting`      — connect in progress (waiting for socket open).
 * - `connected`       — relay WebSocket is open and active.
 * - `paused`          — user explicitly paused; credentials are preserved
 *                       so reconnect is instant.
 * - `no-native-host`  — native messaging host is not installed; the user
 *                       needs to install the Vellum desktop app first.
 */
export type ConnectionPhase = 'disconnected' | 'connecting' | 'connected' | 'paused' | 'no-native-host';

/**
 * Derived view state for the popup's primary and secondary action buttons.
 */
export interface CtaState {
  /** Label for the primary action button. */
  connectLabel: string;
  /** Whether the primary Connect button is enabled. */
  connectEnabled: boolean;
  /** Label for the secondary action button. */
  pauseLabel: string;
  /** Whether the secondary Pause button is enabled. */
  pauseEnabled: boolean;
}

/**
 * Derive the CTA button labels and enablement from the connection phase.
 *
 * | Phase           | Connect              | Pause         |
 * |-----------------|----------------------|---------------|
 * | disconnected    | Connect (on)         | Pause (off)   |
 * | connecting      | Connecting... (off)  | Pause (off)   |
 * | connected       | Connect (off)        | Pause (on)    |
 * | paused          | Connect (on)         | Pause (off)   |
 * | no-native-host  | Connect (off)        | Pause (off)   |
 */
export function deriveCtaState(phase: ConnectionPhase): CtaState {
  switch (phase) {
    case 'disconnected':
      return {
        connectLabel: 'Connect',
        connectEnabled: true,
        pauseLabel: 'Pause',
        pauseEnabled: false,
      };
    case 'connecting':
      return {
        connectLabel: 'Connecting\u2026',
        connectEnabled: false,
        pauseLabel: 'Pause',
        pauseEnabled: false,
      };
    case 'connected':
      return {
        connectLabel: 'Connect',
        connectEnabled: false,
        pauseLabel: 'Pause',
        pauseEnabled: true,
      };
    case 'paused':
      return {
        connectLabel: 'Connect',
        connectEnabled: true,
        pauseLabel: 'Pause',
        pauseEnabled: false,
      };
    case 'no-native-host':
      return {
        connectLabel: 'Connect',
        connectEnabled: false,
        pauseLabel: 'Pause',
        pauseEnabled: false,
      };
  }
}

/**
 * Derived view state for the status indicator (dot + text).
 */
export interface StatusDisplay {
  /** CSS class for the status dot (`connected`, `paused`, `disconnected`). */
  dotClass: string;
  /** User-facing status text. */
  text: string;
}

/**
 * Derive the status dot class and text from the connection phase.
 */
export function deriveStatusDisplay(phase: ConnectionPhase): StatusDisplay {
  switch (phase) {
    case 'disconnected':
      return { dotClass: 'disconnected', text: 'Not connected' };
    case 'connecting':
      return { dotClass: 'disconnected', text: 'Connecting\u2026' };
    case 'connected':
      return { dotClass: 'connected', text: 'Connected to relay server' };
    case 'paused':
      return { dotClass: 'paused', text: 'Paused' };
    case 'no-native-host':
      return { dotClass: 'disconnected', text: 'Desktop app required' };
  }
}

/**
 * Derive a user-facing setup message for phases that require
 * external action (e.g. installing the desktop app).
 *
 * Returns `null` when no setup guidance is needed.
 */
export function deriveSetupMessage(phase: ConnectionPhase): string | null {
  if (phase === 'no-native-host') {
    return (
      'Install the Vellum desktop app to connect. ' +
      'The browser extension requires the desktop app to communicate with your local assistant.'
    );
  }
  return null;
}
