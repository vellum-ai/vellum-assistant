/**
 * Profile API wrappers for the authenticated user.
 *
 * These endpoints live under /v1/user/ and are served directly by Django
 * (not proxied through the assistant daemon), so they sit alongside the
 * other allauth/session helpers in `lib/account/` rather than under a
 * per-assistant `lib/.../api.ts`.
 *
 * `username-available` is intentionally a separate GET endpoint rather
 * than a "try-PATCH, catch 409" — live feedback as the user types should
 * not depend on actually mutating state.
 */

import { client } from "@/generated/api/client.gen.js";
import { ApiError, assertHasResponse, extractErrorMessage } from "@/lib/api/errors.js";

import "@/lib/vellum-api/client.js";

const SDK_BASE_OPTIONS =
  typeof window === "undefined"
    ? ({ baseUrl: "http://localhost" } as const)
    : ({} as const);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UserMe {
  id: string;
  username: string;
  email: string;
  first_name: string;
  last_name: string;
}

/**
 * Stable error codes returned by both the availability endpoint (as
 * `code` in the body) and the PATCH endpoint (in DRF validation-error
 * payloads under `username.0.code` or in the 409 body's `code` field).
 *
 * Mirror the constants in `django/app/users/username_validation.py`.
 */
export type UsernameErrorCode =
  | "too_short"
  | "too_long"
  | "invalid_chars"
  | "leading_underscore"
  | "trailing_underscore"
  | "leading_hyphen"
  | "trailing_hyphen"
  | "all_digits"
  | "reserved"
  | "taken";

export interface UsernameAvailability {
  available: boolean;
  code: UsernameErrorCode | null;
  message: string | null;
}

/**
 * Friendly copy for each error code. The server also sends `message`, but
 * we keep a client-side fallback so the UI stays responsive even if a
 * future server version adds a code the client doesn't know about.
 */
export const USERNAME_ERROR_COPY: Record<UsernameErrorCode, string> = {
  too_short: "Must be at least 3 characters.",
  too_long: "Must be at most 30 characters.",
  invalid_chars: "Use only lowercase letters, digits, hyphens, and underscores.",
  leading_underscore: "Cannot start with an underscore.",
  trailing_underscore: "Cannot end with an underscore.",
  leading_hyphen: "Cannot start with a hyphen.",
  trailing_hyphen: "Cannot end with a hyphen.",
  all_digits: "Cannot be all digits.",
  reserved: "This handle is reserved.",
  taken: "This handle is already taken.",
};

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export async function fetchMe(): Promise<UserMe> {
  const { data, error, response } = await client.get<UserMe, unknown>({
    ...SDK_BASE_OPTIONS,
    url: "/v1/user/me/",
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load profile.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to load profile."),
    );
  }
  return data as UserMe;
}

export interface UpdateMePatch {
  username?: string;
}

/**
 * Result discriminator so the caller can render the right inline message:
 *
 * * `ok`    — saved. New profile in `data`.
 * * `taken` — server rejected the handle as already claimed (409).
 * * `invalid` — server rejected the format (400). `code` is the stable
 *              machine-readable reason when available.
 * * `error` — everything else (5xx, network, CSRF). Surfaced as a toast.
 */
export type UpdateMeResult =
  | { kind: "ok"; data: UserMe }
  | { kind: "taken"; message: string }
  | { kind: "invalid"; code: UsernameErrorCode | null; message: string }
  | { kind: "error"; message: string };

function parseValidationError(body: unknown): {
  code: UsernameErrorCode | null;
  message: string;
} {
  // DRF default: { "username": [{ "code": "...", "string": "..." }] } when
  // using `ValidationError(code=...)`; or { "username": ["message"] } when
  // the code lives elsewhere. Accept both shapes.
  if (body && typeof body === "object") {
    const usernameErr = (body as Record<string, unknown>).username;
    if (Array.isArray(usernameErr) && usernameErr.length > 0) {
      const first = usernameErr[0];
      if (typeof first === "string") {
        return { code: null, message: first };
      }
      if (first && typeof first === "object") {
        const codeRaw = (first as Record<string, unknown>).code;
        const messageRaw =
          (first as Record<string, unknown>).string ??
          (first as Record<string, unknown>).message;
        return {
          code: (typeof codeRaw === "string" ? codeRaw : null) as
            | UsernameErrorCode
            | null,
          message:
            typeof messageRaw === "string"
              ? messageRaw
              : "Please choose a different handle.",
        };
      }
    }
    const detail = (body as Record<string, unknown>).detail;
    if (typeof detail === "string") {
      return { code: null, message: detail };
    }
  }
  return { code: null, message: "Please choose a different handle." };
}

export async function updateMe(patch: UpdateMePatch): Promise<UpdateMeResult> {
  const { data, error, response } = await client.patch<UserMe, unknown>({
    ...SDK_BASE_OPTIONS,
    url: "/v1/user/me/",
    body: patch,
    throwOnError: false,
  });

  if (!response) {
    return {
      kind: "error",
      message:
        extractErrorMessage(error, undefined, "Failed to save profile.") ??
        "Failed to save profile.",
    };
  }

  if (response.ok && data) {
    return { kind: "ok", data };
  }

  if (response.status === 409) {
    const body = error as Record<string, unknown> | undefined;
    const message =
      (body && typeof body.detail === "string" && body.detail) ||
      USERNAME_ERROR_COPY.taken;
    return { kind: "taken", message };
  }

  if (response.status === 400) {
    const { code, message } = parseValidationError(error);
    return { kind: "invalid", code, message };
  }

  return {
    kind: "error",
    message: extractErrorMessage(error, response, "Failed to save profile."),
  };
}

export async function checkUsernameAvailable(
  username: string,
  signal?: AbortSignal,
): Promise<UsernameAvailability> {
  const { data, error, response } = await client.get<
    UsernameAvailability,
    unknown
  >({
    ...SDK_BASE_OPTIONS,
    url: "/v1/user/username-available/",
    query: { username },
    signal,
    throwOnError: false,
  });

  // Any non-2xx response — 429 rate-limit, 5xx, network — is treated as
  // "couldn't check, don't know" and surfaced as a thrown error. The caller
  // shows a non-blocking message and still allows save; the PATCH endpoint
  // does the authoritative validation, so a transient outage of this probe
  // must NOT lock users out of updating their handle.
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
  return data;
}
