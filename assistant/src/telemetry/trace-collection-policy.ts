/**
 * Per-turn trace-collection disclosure gate (daemon side).
 *
 * A "trace" is the full transcript of one assistant turn. Traces are only
 * collected from owners who accepted the diagnostics-sharing consent copy that
 * *discloses* trace collection — identified by its accepted version.
 *
 * This mirrors the platform's authoritative ingest gate in
 * `vellum-assistant-platform`:
 *   - `django/app/core/trace_collection.py` (`is_trace_collection_enabled`)
 *   - `config.settings.TRACE_COLLECTION_MIN_DIAGNOSTICS_CONSENT_VERSION`
 *
 * The daemon applies the same `share_diagnostics_accepted_version >= threshold`
 * check the platform does, so traces for ineligible owners never leave the
 * device. (The platform would drop them anyway, but checking here keeps the PII
 * local — data minimization.)
 *
 * Keep this constant in lockstep with the platform setting. Versions are
 * "YYYY-MM-DD" strings, so the lexicographic compare is chronological; ""
 * (never accepted) and older versions fail closed.
 */
export const TRACE_COLLECTION_MIN_DIAGNOSTICS_CONSENT_VERSION = "2026-06-18";

/**
 * True iff `version` (the owner's `share_diagnostics_accepted_version`) is at or
 * past the disclosing version. Fails closed for "" / older versions.
 */
export function isDiagnosticsConsentVersionEligible(version: string): boolean {
  return version >= TRACE_COLLECTION_MIN_DIAGNOSTICS_CONSENT_VERSION;
}
