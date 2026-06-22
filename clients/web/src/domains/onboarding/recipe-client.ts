/**
 * Fetch the onboarding recipe from the platform backend.
 *
 * The recipe drives the pre-chat onboarding flow: which tasks to show,
 * which tone to default, which skills to install, and whether to skip
 * the pre-chat screens entirely. Unrecognized cohorts (204) and errors
 * degrade to `null` so the caller falls back to the standard flow.
 */

import { client } from "@/generated/api/client.gen.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OnboardingRecipe {
  /** GTM cohort identifier, e.g. "content-automation". */
  cohort: string;
  /** Task IDs to pre-select, e.g. ["writing", "research"]. */
  tasks: string[];
  /** Personality group ID, e.g. "grounded". */
  tone: string;
  /** Template slug to bootstrap the workspace from. */
  bootstrapTemplate: string;
  /** Auto-send this message on first load instead of waiting for user input. */
  initialMessage: string;
  /** Skill IDs to install during onboarding. */
  skills: string[];
  /** When true, skip the pre-chat screens entirely. */
  skipPrechat: boolean;
}

/** Snake-case shape returned by the Django backend. */
interface OnboardingRecipeResponse {
  cohort: string;
  tasks: string[];
  tone: string;
  bootstrap_template: string;
  initial_message: string;
  skills: string[];
  skip_prechat: boolean;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/**
 * Fetch the onboarding recipe for the current user's cohort.
 *
 * Returns `null` when:
 * - The user has no recognized cohort (204 from the backend)
 * - The endpoint returns 404 (backend not yet deployed)
 * - A network or server error occurs
 * - The response body is malformed
 *
 * Callers should fall back to the standard onboarding flow on `null`.
 */
export async function fetchOnboardingRecipe(): Promise<OnboardingRecipe | null> {
  try {
    const { data, response } = await client.get<
      OnboardingRecipeResponse,
      unknown
    >({
      url: "/v1/onboarding/recipe/",
      throwOnError: false,
    });

    if (!response?.ok || !data) return null;

    const body = data as OnboardingRecipeResponse;

    // Validate required fields before mapping
    if (
      typeof body.cohort !== "string" ||
      !Array.isArray(body.tasks) ||
      typeof body.tone !== "string" ||
      typeof body.bootstrap_template !== "string" ||
      typeof body.initial_message !== "string" ||
      !Array.isArray(body.skills) ||
      typeof body.skip_prechat !== "boolean"
    ) {
      return null;
    }

    return {
      cohort: body.cohort,
      tasks: body.tasks,
      tone: body.tone,
      bootstrapTemplate: body.bootstrap_template,
      initialMessage: body.initial_message,
      skills: body.skills,
      skipPrechat: body.skip_prechat,
    };
  } catch {
    // Network error or unexpected failure — degrade to default flow.
    return null;
  }
}
