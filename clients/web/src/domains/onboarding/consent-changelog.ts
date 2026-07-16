/**
 * Per-version "what changed" notes for each consent axis.
 *
 * Each map is keyed by the version string (e.g. "2026-06-22") and holds a short
 * list of bullet points summarizing what changed in that version. The notes are
 * a courtesy summary shown on the review-terms screen — the canonical, complete
 * policy is always the linked document.
 *
 * Bump recipe: when you bump a `*_CONSENT_VERSION` in `consent-persistence.ts`,
 * add a matching dated entry to the corresponding map here describing the
 * change. A missing entry is harmless (renders nothing).
 */

export const TOS_CHANGE_NOTES: Record<string, string[]> = {};

export const PRIVACY_CHANGE_NOTES: Record<string, string[]> = {
  "2026-06-22": ["Introduces Together AI as a new managed model provider"],
};

export const ANALYTICS_CHANGE_NOTES: Record<string, string[]> = {};

export const DIAGNOSTICS_CHANGE_NOTES: Record<string, string[]> = {};

export function tosChangeNotes(version: string): string[] {
  return TOS_CHANGE_NOTES[version] ?? [];
}

export function privacyChangeNotes(version: string): string[] {
  return PRIVACY_CHANGE_NOTES[version] ?? [];
}

export function analyticsChangeNotes(version: string): string[] {
  return ANALYTICS_CHANGE_NOTES[version] ?? [];
}

export function diagnosticsChangeNotes(version: string): string[] {
  return DIAGNOSTICS_CHANGE_NOTES[version] ?? [];
}
