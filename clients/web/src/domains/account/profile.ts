import { client } from "@/generated/api/client.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";
import { parseDrfFieldError } from "@/domains/account/parse-drf-field-error";

export interface UserConsent {
  tos_accepted_version: string;
  tos_accepted_at: string | null;
  privacy_policy_accepted_version: string;
  privacy_policy_accepted_at: string | null;
  ai_data_sharing_accepted_version: string;
  ai_data_sharing_accepted_at: string | null;
  /** Null until the user makes an explicit choice (settings or review-terms). */
  share_analytics: boolean | null;
  share_diagnostics: boolean;
  share_analytics_accepted_version: string;
  share_analytics_accepted_at: string | null;
  share_diagnostics_accepted_version: string;
  share_diagnostics_accepted_at: string | null;
}

export type ConsentPatch = Partial<
  Omit<
    UserConsent,
    | "tos_accepted_at"
    | "privacy_policy_accepted_at"
    | "ai_data_sharing_accepted_at"
    | "share_analytics_accepted_at"
    | "share_diagnostics_accepted_at"
  >
>;

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
  invalid_chars:
    "Use only lowercase letters, digits, hyphens, and underscores.",
  leading_underscore: "Cannot start with an underscore.",
  trailing_underscore: "Cannot end with an underscore.",
  leading_hyphen: "Cannot start with a hyphen.",
  trailing_hyphen: "Cannot end with a hyphen.",
  all_digits: "Cannot be all digits.",
  reserved: "This handle is reserved.",
  taken: "This handle is already taken.",
};

export async function fetchMe(): Promise<UserMe> {
  const { data, error, response } = await client.get<UserMe, unknown>({
    url: "/v1/user/me/",
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load profile.");
  if (!response.ok || !data) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to load profile."),
    );
  }
  return data;
}

export interface UpdateMePatch {
  username?: string;
}

export type UpdateMeResult =
  | { kind: "ok"; data: UserMe }
  | { kind: "taken"; message: string }
  | { kind: "invalid"; code: UsernameErrorCode | null; message: string }
  | { kind: "error"; message: string };

const DEFAULT_USERNAME_ERROR = "Please choose a different handle.";

export async function updateMe(patch: UpdateMePatch): Promise<UpdateMeResult> {
  const { data, error, response } = await client.patch<UserMe, unknown>({
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
    const { message } = parseDrfFieldError(
      error,
      "username",
      USERNAME_ERROR_COPY.taken,
    );
    return { kind: "taken", message };
  }

  if (response.status === 400) {
    const { code, message } = parseDrfFieldError(
      error,
      "username",
      DEFAULT_USERNAME_ERROR,
    );
    return { kind: "invalid", code: code as UsernameErrorCode | null, message };
  }

  return {
    kind: "error",
    message: extractErrorMessage(error, response, "Failed to save profile."),
  };
}

export async function fetchConsent(): Promise<UserConsent> {
  const { data, error, response } = await client.get<UserConsent, unknown>({
    url: "/v1/user/consent/",
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load consent.");
  if (!response.ok || !data) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to load consent."),
    );
  }
  return data;
}

// PUTs /v1/user/consent/ — partial bodies are accepted, no writable field is required.
export async function patchConsent(consent: ConsentPatch): Promise<void> {
  await client.put({
    url: "/v1/user/consent/",
    body: consent,
    throwOnError: true,
  });
}

export async function checkUsernameAvailable(
  username: string,
  signal?: AbortSignal,
): Promise<UsernameAvailability> {
  const { data, error, response } = await client.get<
    UsernameAvailability,
    unknown
  >({
    url: "/v1/user/username-available/",
    query: { username },
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
  return data;
}
