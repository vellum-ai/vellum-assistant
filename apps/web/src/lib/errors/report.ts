import { toast } from "@vellum/design-library";

/**
 * Reports an error and optionally shows a user-facing toast.
 *
 * Logs to the console; Sentry integration can be wired up later via an
 * optional dependency.
 */
export function reportError(
  error: unknown,
  opts: { context: string; userMessage?: string },
): void {
  console.error(`[${opts.context}]`, error);

  if (opts.userMessage) {
    toast.error(opts.userMessage);
  }
}
