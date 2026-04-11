/**
 * Pure view-state helpers for the popup UI.
 *
 * These functions derive display state from the worker's structured
 * connection health contract, the assistant catalog, and selection
 * data. They are deliberately side-effect-free so they can be unit
 * tested without a Chrome runtime environment.
 *
 * The popup shows concise primary states to the user:
 *   - **Connected** — background relay active.
 *   - **Reconnecting automatically** — transient disconnect, recovery
 *     in progress.
 *   - **Paused** — user explicitly paused; credentials preserved.
 *   - **Action required** — auth/host error requiring manual recovery.
 *
 * Primary controls remain **Connect** and **Pause**. Manual recovery
 * actions (Pair / Sign-in) live in a collapsible Troubleshoot area
 * that is hidden by default unless the health state is `auth_required`
 * or `error`.
 */

import type { AssistantDescriptor } from '../background/native-host-assistants.js';
import type { AssistantAuthProfile } from '../background/assistant-auth-profile.js';

// ── Health state types (mirrored from worker.ts) ───────────────────

/**
 * The structured connection health state published by the worker via
 * `get_status`. This is the canonical source of truth for the popup's
 * display state.
 */
export type ConnectionHealthState =
  | 'paused'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'auth_required'
  | 'error';

/**
 * Detail fields attached to the current health state from the worker.
 */
export interface ConnectionHealthDetail {
  lastDisconnectCode?: number;
  lastErrorMessage?: string;
  lastChangeAt: number;
}

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
 * Response shape from the worker's `get_status` message.
 */
export interface GetStatusResponse {
  connected: boolean;
  authProfile: AssistantAuthProfile | null;
  health: ConnectionHealthState;
  healthDetail: ConnectionHealthDetail;
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
 * - `disconnected` — idle, no active relay connection.
 * - `connecting`   — connect in progress (waiting for socket open).
 * - `connected`    — relay WebSocket is open and active.
 * - `paused`       — user explicitly paused; credentials are preserved
 *                    so reconnect is instant.
 */
export type ConnectionPhase = 'disconnected' | 'connecting' | 'connected' | 'paused';

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
 * | Phase        | Connect       | Pause         |
 * |--------------|---------------|---------------|
 * | disconnected | Connect (on)  | Pause (off)   |
 * | connecting   | Connecting... (off) | Pause (off) |
 * | connected    | Connect (off) | Pause (on)    |
 * | paused       | Connect (on)  | Pause (off)   |
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
  }
}

// ── Health-aware state mapping ──────────────────────────────────────
//
// These functions consume the worker's structured ConnectionHealthState
// to produce the popup's concise user-facing display. They replace the
// older boolean-based `connected` field with deterministic mapping from
// the six-state health enum.

/**
 * Map the worker's health state to the popup's connection phase.
 *
 * The popup phase is a simplified view of the health state:
 *   - `connected` and `reconnecting` both map to phases that keep
 *     the user informed without requiring action.
 *   - `auth_required` and `error` map to `disconnected` since the
 *     user may need to take action.
 *   - `paused` and `connecting` map directly.
 */
export function healthToPhase(health: ConnectionHealthState): ConnectionPhase {
  switch (health) {
    case 'connected':
      return 'connected';
    case 'connecting':
      return 'connecting';
    case 'reconnecting':
      return 'connecting';
    case 'paused':
      return 'paused';
    case 'auth_required':
      return 'disconnected';
    case 'error':
      return 'disconnected';
  }
}

/**
 * Derive a concise, user-facing status display from the worker's
 * health state and detail. This produces friendlier messages than the
 * phase-based `deriveStatusDisplay` for health states that have no
 * direct phase equivalent (reconnecting, auth_required, error).
 *
 * | Health state   | Dot class     | Status text                              |
 * |----------------|---------------|------------------------------------------|
 * | connected      | connected     | Connected                                |
 * | connecting     | disconnected  | Connecting...                            |
 * | reconnecting   | paused        | Reconnecting automatically...            |
 * | paused         | paused        | Paused                                   |
 * | auth_required  | disconnected  | Action required (+ detail if available)  |
 * | error          | disconnected  | Error (+ detail if available)            |
 */
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
          ? `Action required: ${detail.lastErrorMessage}`
          : 'Action required \u2014 sign in or re-pair to continue',
      };
    case 'error':
      return {
        dotClass: 'disconnected',
        text: detail?.lastErrorMessage
          ? `Error: ${detail.lastErrorMessage}`
          : 'Connection error',
      };
  }
}

// ── Troubleshooting visibility ──────────────────────────────────────

/**
 * Whether the Troubleshoot section should be expanded (visible) by
 * default based on the current health state.
 *
 * The section is expanded when the health state requires user action:
 *   - `auth_required` — credentials expired/missing, user must
 *     re-pair or re-sign-in.
 *   - `error` — unrecoverable error, manual recovery may help.
 *
 * For all other states (`connected`, `connecting`, `reconnecting`,
 * `paused`) the section is collapsed so typical users see only the
 * concise primary status without implementation details.
 */
export function shouldExpandTroubleshooting(health: ConnectionHealthState): boolean {
  return health === 'auth_required' || health === 'error';
}

/**
 * Whether troubleshooting auth controls are relevant given the auth
 * profile. When the profile is null or unsupported, there are no
 * auth controls to show regardless of health state.
 */
export function hasTroubleshootingControls(
  authProfile: AssistantAuthProfile | null,
): boolean {
  return authProfile === 'local-pair' || authProfile === 'cloud-oauth';
}
