import type {
  FormField,
  FormSurfaceData,
} from "../../daemon/message-protocol.js";
import type { AuthChallenge, AuthField } from "./auth-detector.js";

/**
 * Build a FormSurfaceData suitable for ui_show that prompts the user
 * for the credentials required by the given auth challenge.
 */
export function buildAuthForm(challenge: AuthChallenge): FormSurfaceData {
  const serviceName = challenge.service ?? "this website";
  const description =
    challenge.type === "login"
      ? `Sign in to ${serviceName}. Your password will be masked.`
      : challenge.type === "2fa"
        ? `${serviceName} needs a verification code to continue.`
        : `${serviceName} is asking for permission.`;

  const fields: FormField[] = challenge.fields.map((field, i) => ({
    id:
      field.type === "password"
        ? "password"
        : field.type === "email"
          ? "email"
          : field.type === "code"
            ? "code"
            : `field_${i}`,
    type: mapAuthFieldType(field.type),
    label: field.label,
    placeholder:
      field.type === "email"
        ? "you@example.com"
        : field.type === "password"
          ? "Enter your password"
          : field.type === "code"
            ? "Enter the code"
            : undefined,
    required: true,
  }));

  return {
    description,
    fields,
    submitLabel: challenge.type === "oauth_consent" ? "Approve" : "Continue",
  };
}

function mapAuthFieldType(authType: AuthField["type"]): FormField["type"] {
  switch (authType) {
    case "password":
      return "password";
    case "email":
      return "text";
    case "code":
      return "text";
    case "approval":
      return "toggle";
  }
}

/**
 * Build a timeout message for when the user hasn't responded to the auth prompt.
 */
export function buildTimeoutMessage(challenge: AuthChallenge): string {
  const serviceName = challenge.service ?? "the website";
  return challenge.type === "2fa"
    ? `No rush - just let me know when you've got the verification code from ${serviceName}.`
    : `Take your time - I'll continue once you sign in to ${serviceName}.`;
}
