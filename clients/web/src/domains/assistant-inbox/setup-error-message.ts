/**
 * The platform relays an email provider's refusal verbatim inside its own
 * sentence, e.g. `Failed to provision email domain: {"statusCode":403,
 * "message":"You have reached the domain limit of your plan.","name":
 * "validation_error"}`. The user should read the provider's sentence, not
 * its envelope, so the JSON is swapped for its `message` when it has one.
 */
export function readableSetupError(detail: string): string {
  const match = /\{[^{}]*\}/.exec(detail);
  if (!match) {
    return detail;
  }
  try {
    const parsed: unknown = JSON.parse(match[0]);
    if (
      parsed &&
      typeof parsed === "object" &&
      "message" in parsed &&
      typeof parsed.message === "string" &&
      parsed.message.trim() !== ""
    ) {
      return detail.replace(match[0], parsed.message.trim());
    }
  } catch {
    // Not JSON after all; the sentence stands as it came.
  }
  return detail;
}

/**
 * The platform's `POST …/domains/` claims the subdomain, then registers the
 * address on it as a best effort: an address that could not be created
 * comes back as `email_error` on an otherwise successful response, which
 * the generated type does not carry.
 */
export interface DomainEmailError {
  detail?: string;
  code?: string;
}

export function readDomainEmailError(
  response: unknown,
): DomainEmailError | null {
  if (
    !response ||
    typeof response !== "object" ||
    !("email_error" in response)
  ) {
    return null;
  }
  const error = response.email_error;
  if (!error || typeof error !== "object") {
    return null;
  }
  const detail = "detail" in error ? error.detail : undefined;
  const code = "code" in error ? error.code : undefined;
  return {
    detail: typeof detail === "string" ? detail : undefined,
    code: typeof code === "string" ? code : undefined,
  };
}
