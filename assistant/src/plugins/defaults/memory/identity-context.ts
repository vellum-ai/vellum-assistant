import { resolveGuardianPersona } from "../../../prompts/persona-resolver.js";
import { readPromptFile } from "../../../prompts/system-prompt.js";
import { isTemplateContent } from "../../../prompts/template-detection.js";
import { getWorkspacePromptPath } from "../../../util/platform.js";

const IDENTITY_PROMPT_FILES = ["IDENTITY.md", "SOUL.md"] as const;

/**
 * The assistant's self-description for memory's own model calls: IDENTITY.md
 * and SOUL.md from the workspace, plus the guardian's user persona. Returns
 * null when none are present.
 *
 * Memory owns this composition — what its prompts include is a plugin
 * concern. The output is kept in lockstep with the host's out-of-band
 * identity block (`buildCoreIdentityContext`) by
 * `memory-identity-context-parity.test.ts`; diverge deliberately, not by
 * accident.
 */
export function buildIdentityContext(): string | null {
  const parts: string[] = [];
  for (const file of IDENTITY_PROMPT_FILES) {
    const content = readPromptFile(getWorkspacePromptPath(file));
    if (!content) {
      continue;
    }
    // SOUL.md always counts — it provides personality defaults even before
    // onboarding completes. Only skip IDENTITY.md while it is still an
    // unmodified template.
    if (file !== "SOUL.md" && isTemplateContent(content, file)) {
      continue;
    }
    parts.push(content);
  }
  const guardianPersona = resolveGuardianPersona();
  if (guardianPersona) {
    parts.push(guardianPersona);
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}
