import * as Sentry from "@sentry/react";

import { toast } from "@vellum/design-library/components/toast";

/**
 * Reports an error to Sentry and optionally shows a user-facing toast.
 *
 * @param error - The caught error value
 * @param opts.context - A Sentry tag identifying where the error occurred
 * @param opts.userMessage - If provided, displayed as an error toast to the user
 */
export function reportError(
  error: unknown,
  opts: { context: string; userMessage?: string },
): void {
  Sentry.captureException(error, {
    tags: { context: opts.context },
  });

  if (opts.userMessage) {
    toast.error(opts.userMessage);
  }
}
