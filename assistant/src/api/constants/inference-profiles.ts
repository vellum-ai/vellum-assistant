/**
 * Inference-profile key constants shared across the assistant backend,
 * the web client, and any consumer of `@vellumai/assistant-api`.
 *
 * These keys are wire-level identifiers — the backend's config seeder,
 * the plugin API, and the UI picker gating all branch on the same
 * string literals, so centralizing them prevents drift.
 */

/**
 * The "auto" meta-profile key. The daemon seeds this entry into
 * `llm.profiles` unconditionally so a switched-on
 * `query-complexity-routing` flag has something to point at. The entry
 * carries no provider/model of its own — when selected, the daemon
 * injects a `switch_inference_profile` tool and the model self-selects
 * a concrete profile per query.
 *
 * Every surface that lists profiles as concrete dispatch targets
 * (UI pickers, `getModelProfiles()`) must exclude this key — it is not
 * a valid routing target for an actual LLM call.
 */
export const AUTO_PROFILE_KEY = "auto";
