/**
 * Assistant-handle API wrappers (claim flow + live availability check).
 *
 * Parallel to ``domains/account/profile.ts`` (user handle). The Django server
 * uses the same error codes on both surfaces so the client can share the
 * ``UsernameErrorCode`` enum and ``USERNAME_ERROR_COPY`` map. We re-export
 * them from this module under handle-specific aliases so consumers can
 * import handle types without reaching into the user-handle module for
 * assistant concerns.
 */

import {
  assistantsHandleAvailableRetrieve,
  assistantsPartialUpdate,
} from "@/generated/api/sdk.gen";
import type { Assistant } from "@/generated/api/types.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";
import { parseDrfFieldError } from "@/domains/account/parse-drf-field-error";
import {
  USERNAME_ERROR_COPY,
  type UsernameErrorCode,
} from "@/domains/account/profile";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Server-canonical error codes for the assistant-handle surface. Identical
 * to ``UsernameErrorCode`` on the user surface — re-exported under a handle
 * alias so call sites can import only what they need.
 */
export type HandleErrorCode = UsernameErrorCode;

/** Friendly client-side copy keyed by error code (shared with user handle). */
export const HANDLE_ERROR_COPY: Record<HandleErrorCode, string> =
  USERNAME_ERROR_COPY;

export interface HandleAvailability {
  available: boolean;
  code: HandleErrorCode | null;
  message: string | null;
}

/**
 * Result discriminator for the save path so the UI can render the right
 * inline state. Mirrors ``UpdateMeResult``:
 *
 * * ``ok``      — saved; updated Assistant in ``data``.
 * * ``taken``   — server rejected the handle as already claimed (409).
 * * ``invalid`` — server rejected the format (400). ``code`` is the stable
 *                 machine-readable reason when available.
 * * ``error``   — everything else (5xx, network). Surfaced as a toast.
 */
export type UpdateAssistantHandleResult =
  | { kind: "ok"; data: Assistant }
  | { kind: "taken"; message: string }
  | { kind: "invalid"; code: HandleErrorCode | null; message: string }
  | { kind: "error"; message: string };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_HANDLE_ERROR = "Please choose a different handle.";

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

/**
 * Save a new handle for the given assistant. Surfaces 409 (taken) and 400
 * (format invalid) as discriminated values rather than thrown errors so the
 * UI can render inline state.
 */
export async function updateAssistantHandle(
  assistantId: string,
  handle: string,
): Promise<UpdateAssistantHandleResult> {
  const { data, error, response } = await assistantsPartialUpdate({
    path: { id: assistantId },
    body: { handle },
    throwOnError: false,
  });

  if (!response) {
    return {
      kind: "error",
      message:
        extractErrorMessage(error, undefined, "Failed to save handle.") ??
        "Failed to save handle.",
    };
  }

  if (response.ok && data) {
    return { kind: "ok", data };
  }

  if (response.status === 409) {
    const { message } = parseDrfFieldError(
      error,
      "handle",
      HANDLE_ERROR_COPY.taken,
    );
    return { kind: "taken", message };
  }

  if (response.status === 400) {
    const { code, message } = parseDrfFieldError(
      error,
      "handle",
      DEFAULT_HANDLE_ERROR,
    );
    return { kind: "invalid", code: code as HandleErrorCode | null, message };
  }

  return {
    kind: "error",
    message: extractErrorMessage(error, response, "Failed to save handle."),
  };
}

/**
 * Live availability check used to give immediate feedback as the user types.
 * The PATCH endpoint does the authoritative validation, so a transient
 * outage of this probe must NOT lock users out — the caller catches the
 * thrown ApiError and renders a non-blocking notice while still allowing
 * save.
 */
export async function checkAssistantHandleAvailable(
  assistantId: string,
  handle: string,
  signal?: AbortSignal,
): Promise<HandleAvailability> {
  const { data, error, response } = await assistantsHandleAvailableRetrieve({
    path: { assistant_id: assistantId },
    query: { handle },
    signal,
    throwOnError: false,
  });

  assertHasResponse(response, error, "Failed to check handle availability.");
  if (!response.ok || !data) {
    throw new ApiError(
      response.status,
      response.status === 429
        ? "Too many checks — try again in a moment."
        : extractErrorMessage(
            error,
            response,
            "Failed to check handle availability.",
          ),
    );
  }
  // Server sends ``code: null`` for available results — narrow to the
  // typed shape so consumers can switch on the code without casting.
  return {
    available: data.available,
    code: (data.code ?? null) as HandleErrorCode | null, // server sends string|null; narrow to known codes
    message: data.message ?? null,
  };
}
