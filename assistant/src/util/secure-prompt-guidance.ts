/**
 * Next-step copy when a secret must be collected through the in-app
 * secure prompt. Omits CLI argv so the model does not show a command
 * the user cannot run from their terminal.
 */

export const DO_NOT_SHOW_CREDENTIALS_CLI =
  "Do not print a CLI command or ask the user to run one.";

export function securePromptGuidance(opts?: {
  service?: string;
  field?: string;
  verb?: "Collect" | "Re-collect";
  /** When false, the verb starts lowercase so the sentence can follow "or". */
  capitalize?: boolean;
}): string {
  const identity =
    opts?.service && opts?.field
      ? `${opts.service}/${opts.field}`
      : opts?.service;
  const subject = identity ? ` for ${identity}` : "";
  const verbRaw = opts?.verb ?? "Collect";
  const verb =
    opts?.capitalize === false
      ? verbRaw.charAt(0).toLowerCase() + verbRaw.slice(1)
      : verbRaw;
  return `${verb} it through the in-app secure prompt${subject}. ${DO_NOT_SHOW_CREDENTIALS_CLI}`;
}
