/**
 * Profile API wrappers for the authenticated user.
 *
 * These endpoints live under /v1/user/ and are served directly by Django
 * (not proxied through the assistant daemon), so they sit alongside the
 * other allauth/session helpers in `lib/account/` rather than under a
 * per-assistant domain.
 */

import { client } from "@/generated/api/client.gen.js";
import { ApiError, assertHasResponse, extractErrorMessage } from "@/lib/api-errors.js";

import "@/lib/api-client.js";

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

export type UpdateMeResult =
  | { kind: "ok"; data: UserMe }
  | { kind: "taken"; message: string }
  | { kind: "invalid"; code: UsernameErrorCode | null; message: string }
  | { kind: "error"; message: string };

function parseValidationError(body: unknown): {
  code: UsernameErrorCode | null;
  message: string;
} {
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
    return { kind: "error", message: "Network error. Please try again." };
  }

  if (response.ok) {
    return { kind: "ok", data: data as UserMe };
  }

  if (response.status === 409) {
    const body = error as Record<string, unknown> | undefined;
    const message =
      typeof body?.message === "string"
        ? body.message
        : "This handle is already taken.";
    return { kind: "taken", message };
  }

  if (response.status === 400) {
    const { code, message } = parseValidationError(error);
    return { kind: "invalid", code, message };
  }

  return {
    kind: "error",
    message: extractErrorMessage(error, response, "Failed to update profile."),
  };
}

export async function checkUsernameAvailability(
  username: string,
): Promise<UsernameAvailability> {
  const { data, error, response } = await client.get<
    UsernameAvailability,
    unknown
  >({
    ...SDK_BASE_OPTIONS,
    url: `/v1/user/username-available/?username=${encodeURIComponent(username)}`,
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to check username.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to check username."),
    );
  }
  return data as UsernameAvailability;
}
