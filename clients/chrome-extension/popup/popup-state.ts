/**
 * Pure view-state helpers for the popup assistant selector.
 *
 * These functions derive display state from the assistant catalog and
 * selection data returned by the worker's `assistants-get` message.
 * They are deliberately side-effect-free so they can be unit tested
 * without a Chrome runtime environment.
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
