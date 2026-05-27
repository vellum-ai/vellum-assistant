import { client } from "@/generated/api/client.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/lib/api-errors";

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
    const detail = (body as Record<string, unknown>).detail;
    if (typeof detail === "string") {
      return { code: null, message: detail };
    }
  }
  return { code: null, message: "Please choose a different handle." };
}

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
