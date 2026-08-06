/**
 * Renames the assistant from the identity overview page.
 *
 * There is no identity write endpoint — the assistant's name lives on
 * IDENTITY.md's `- **Name:** …` line, which feeds every conversation's
 * system prompt. So a rename is a targeted rewrite turn on a throwaway side
 * conversation (see `runIdentityRewrite`): the message pins the exact line
 * format so the onboarding name-seeder's regex keeps matching on later
 * rewrites, and scopes the edit to the name alone.
 */

import { runIdentityRewrite } from "./run-identity-rewrite";

/**
 * Render the rename system-message. Pure, so it's unit-testable without the
 * daemon.
 */
export function buildRenameMessage(newName: string): string {
  const name = newName.trim();
  return `<system-message>
The user renamed you: your name is now ${name}.

Update IDENTITY.md so its name line reads exactly \`- **Name:** ${name}\`. This is a rename only — keep everything else in IDENTITY.md and SOUL.md exactly as it is, and do not touch users/ (that is your user's profile, not your identity). If your name appears elsewhere in those files, update those mentions to ${name} too.

Reply with a single short sentence acknowledging your new name.
</system-message>`;
}

/**
 * Apply the rename on a throwaway side conversation. Resolves `true` once
 * the rewrite turn settled, `false` on any failure; never throws.
 */
export async function applyRename(
  assistantId: string,
  newName: string,
): Promise<boolean> {
  return runIdentityRewrite({
    assistantId,
    content: buildRenameMessage(newName),
    title: "Updating name",
    context: "identity_overview_rename",
  });
}
